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
 * Poll the backend and report down → up transitions.
 *
 * The first probe is a baseline only: a shell that starts while dsh is already
 * running has not witnessed a restart, and reloading the page then would be an
 * unexplained flash.
 *
 * @param {{ url?: string, probe?: (url?: string) => Promise<boolean>,
 *   onRestart?: () => void, intervalMs?: number }} [options]
 * @returns {() => void} stop polling
 */
export function watchBackend({ url, probe = defaultProbe, onRestart = () => {}, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let lastUp = null
  let inFlight = false
  let stopped = false

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
      return
    }
    const cameBack = up && !lastUp
    lastUp = up
    if (cameBack) {
      try {
        onRestart()
      } catch {
        // a broken reload path must not stop the watchdog
      }
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
