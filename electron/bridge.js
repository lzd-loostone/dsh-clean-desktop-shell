/**
 * Decision delivery: shell overlay → dsh web page.
 *
 * The overlay used to hand a decision to the main window's webContents; that
 * window is gone, so the decision travels over HTTP to the loop-back route
 * the host half registered (src/host/bridge.js). The token is minted by the
 * host half and left in $DSH_HOME, which is how this process learns it —
 * the same handshake file pattern the state snapshot already uses.
 *
 * Deliberately Electron-free so the wire contract can be tested in plain
 * node: the caller passes the payload, the route hands back a client count.
 */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DECIDE_PATH = '/dsh-clean-desktop-shell/decide'
// A tray click must feel instant; the local route answers in single-digit ms.
const TIMEOUT_MS = 1500

/** Handshake file written by the host half (see docs in src/host/bridge.js). */
export function bridgeFilePath(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(home, 'desktop-shell-bridge.json')
}

/** { url, token } from the last host-half mount, or null. */
export function bridgeInfo() {
  try {
    const info = JSON.parse(readFileSync(bridgeFilePath(), 'utf8'))
    if (!info || typeof info.token !== 'string' || !info.token) return null
    return { url: typeof info.url === 'string' && info.url ? info.url : null, token: info.token }
  } catch {
    return null
  }
}

const DEFAULT_ATTEMPTS = 20
const DEFAULT_INTERVAL_MS = 500

/**
 * Deliver a decision, opening the app first when nobody is listening yet.
 *
 * A window that was just started needs a moment before its page reconnects to
 * the loop-back route, so frames sent in that gap are dropped. Repeats are
 * safe: the page ignores an approve/answer it has no pending interaction for,
 * and a repeated goto just opens the same session again.
 *
 * @param {{ type: 'goto'|'approve'|'answer', sessionId: string }} payload
 * @param {{ forward?: () => Promise<unknown>, open?: () => Promise<unknown>,
 *   send?: (p: object) => Promise<number>, attempts?: number, intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<number>} pages that finally accepted the frame (0 = gave up)
 */
export async function deliverWithRetry(
  payload,
  {
    forward,
    open = async () => {},
    send = sendDecision,
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    sleep = defaultSleep,
  } = {},
) {
  // A frame that makes the page jump is pointless behind another window: the
  // user asked to see that session, so surface the window first. A failed
  // forward must still deliver — the page swap is the part that matters.
  if (forward) {
    try {
      await forward()
    } catch {
      // delivery is still worth attempting
    }
  }
  let delivered = await send(payload)
  if (delivered > 0) return delivered
  await open()
  // The first send already happened, so the budget counts from there.
  for (let i = 1; i < attempts; i++) {
    await sleep(intervalMs)
    delivered = await send(payload)
    if (delivered > 0) return delivered
  }
  return delivered
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deliver one decision frame to every open page.
 *
 * @param {{ type: 'goto'|'approve'|'answer', sessionId: string }} payload
 * @returns {Promise<number>} how many pages were listening; 0 means the
 *   caller should fall back to opening the browser. Never rejects.
 */
export function sendDecision(payload) {
  const info = bridgeInfo()
  if (!info || !info.url) return Promise.resolve(0)
  const body = JSON.stringify(payload)
  return new Promise((resolve) => {
    let settled = false
    const done = (n) => {
      if (settled) return
      settled = true
      resolve(n)
    }
    let req
    try {
      req = request(
        info.url + DECIDE_PATH,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-shell-token': info.token,
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { text += c })
          res.on('end', () => {
            try {
              done(Number(JSON.parse(text).delivered) || 0)
            } catch {
              done(0)
            }
          })
        },
      )
    } catch {
      done(0)
      return
    }
    req.on('timeout', () => { req.destroy(); done(0) })
    req.on('error', () => done(0))
    req.end(body)
  })
}
