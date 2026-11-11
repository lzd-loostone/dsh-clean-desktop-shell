/**
 * Backend restart watchdog.
 *
 * A restart (manual from the tray, or a crash the supervisor respawns) leaves
 * every open page holding a socket to a process that is gone. The page cannot
 * tell a restart from a network blip, so the shell watches the service and
 * asks the page to re-mount once the new process is actually answering.
 *
 * Electron-free for testing: the probe is injected and defaults to the shared
 * liveness probe.
 */
import { probe as defaultProbe } from './probe.js'

const DEFAULT_INTERVAL_MS = 3000

/**
 * Wrap a probe with a trace line, so a disputed reload can be explained from
 * the shell trace log instead of guessed at.
 *
 * @param {(url?: string) => Promise<boolean>} probeImpl
 * @param {(line: string) => void} trace
 * @returns {(url?: string) => Promise<boolean>}
 */
export function timedProbe(probeImpl, trace) {
  return async (url) => {
    const started = Date.now()
    let up = false
    try {
      up = await probeImpl(url)
    } catch {
      up = false
    }
    try {
      trace(['probe', up ? 'ok' : 'fail', `${Date.now() - started}ms`, url ?? ''].filter(Boolean).join(' '))
    } catch {
      // a broken trace sink must not change what the probe decided
    }
    return up
  }
}

export const FAIL_THRESHOLD = 2

/**
 * Poll the backend and report down → up transitions.
 *
 * The first probe is a baseline only: a shell that starts while dsh is already
 * running has not witnessed a restart, and reloading the page then would be an
 * unexplained flash.
 *
 * A single failed probe is not a down state: a starved process (a plugin page
 * pulling megabytes of JSON) answers late, and reloading the page for that
 * would be the very flicker this watchdog exists to avoid. `failThreshold`
 * consecutive misses are required before the watcher believes the backend is
 * gone, and only the following success is a restart.
 *
 * @param {{ url?: string, probe?: (url?: string) => Promise<boolean>,
 *   onRestart?: () => void, intervalMs?: number, failThreshold?: number }} [options]
 * @returns {() => void} stop polling
 */
export function watchBackend({
  url,
  probe = defaultProbe,
  onRestart = () => {},
  onChange = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  failThreshold = FAIL_THRESHOLD,
} = {}) {
  let lastUp = null
  let failures = 0
  let inFlight = false
  let stopped = false

  const report = (up) => {
    try {
      onChange(up)
    } catch {
      // a broken listener must not stop the watchdog
    }
  }

  const tick = async () => {
    // A slow probe must not stack up ticks behind it.
    if (stopped || inFlight) return
    inFlight = true
    let up = false
    try {
      up = await probe(url)
    } catch {
      up = false
    } finally {
      inFlight = false
    }
    if (stopped) return
    if (lastUp === null) {
      lastUp = up
      // The shell can be spawned before the backend binds its port; the tray
      // and orb read their labels from this state, so the baseline is
      // published too — otherwise they offer "start backend" for a backend
      // that is already serving.
      report(up)
      return
    }
    if (up) {
      failures = 0
      if (!lastUp) {
        lastUp = true
        report(true)
        try {
          onRestart()
        } catch {
          // a broken reload path must not stop the watchdog
        }
      }
      return
    }
    failures += 1
    if (lastUp && failures >= failThreshold) {
      lastUp = false
      report(false)
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
