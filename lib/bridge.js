/**
 * Browser loop-back channel for the task overlay.
 *
 * The overlay (Electron) can no longer hand a decision to a shell window, so
 * the decision has to reach whichever page has the session open. Two routes
 * ride on the web server dsh already listens on, which makes them same-origin
 * for that page and needs no extra port:
 *
 *   GET  /dsh-clean-desktop-shell/events   SSE stream (page → host)
 *   POST /dsh-clean-desktop-shell/decide   token-gated delivery (overlay → host)
 *
 * The page half (src/client/client.js) answers with the official pending-*
 * APIs; this module only moves frames. Local only by design: the token lives
 * in $DSH_HOME next to the state file, and the POST carries it in a header.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './common.js'

export const EVENTS_PATH = '/dsh-clean-desktop-shell/events'
export const DECIDE_PATH = '/dsh-clean-desktop-shell/decide'

const TOKEN_HEADER = 'x-shell-token'
const MAX_BODY = 8 * 1024
// Proxies and half-open sockets drop a silent stream; a comment line every
// 15s keeps it alive without waking the page.
const HEARTBEAT_MS = 15000
const TYPES = new Set(['goto', 'approve', 'answer'])

/** Where the token handshake file lives (read by the Electron shell). */
export function bridgeFilePath(home = dshHome()) {
  return join(home, 'desktop-shell-bridge.json')
}

function writeTokenFile(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows rename can lose the race with AV scanners — drop and retry,
    // then fall back to a plain write.
    try {
      rmSync(file, { force: true })
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
      size += buf.length
      if (size > MAX_BODY) {
        req.destroy?.()
        resolve(null)
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Register the two routes on the running web server.
 *
 * @param {{ register: Function, getOrigin?: () => string }} webServer
 * @param {{ home?: string }} [options] — home override for tests
 * @returns {() => void} unregister + drop clients + delete the token file
 */
export function startBridge(webServer, { home } = {}) {
  const token = randomBytes(16).toString('hex')
  const file = bridgeFilePath(home)
  const clients = new Set()

  const events = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    clients.add(res)
    // ServerResponse 'close' is the reliable disconnect signal for a
    // completed request; req 'close' would fight the SSE semantics.
    const drop = () => clients.delete(res)
    res.on('close', drop)
    res.on('error', drop)
  }

  const decide = async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    if (req.headers[TOKEN_HEADER] !== token) return json(res, 403, { error: 'bad token' })
    const raw = await readBody(req)
    let msg = null
    try {
      msg = raw && JSON.parse(raw)
    } catch {
      msg = null
    }
    if (!msg || !TYPES.has(msg.type) || typeof msg.sessionId !== 'string' || !msg.sessionId) {
      return json(res, 400, { error: 'bad payload' })
    }
    const frame = `data: ${JSON.stringify(msg)}\n\n`
    let delivered = 0
    for (const client of clients) {
      try {
        client.write(frame)
        delivered++
      } catch {
        clients.delete(client)
      }
    }
    json(res, 200, { delivered })
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  writeTokenFile(file, { url: webServer.getOrigin?.() ?? null, token })

  const offEvents = webServer.register({ kind: 'exact', path: EVENTS_PATH, handler: events })
  const offDecide = webServer.register({ kind: 'exact', path: DECIDE_PATH, handler: decide })

  return () => {
    clearInterval(heartbeat)
    try {
      offEvents()
      offDecide()
    } catch {
      // already gone
    }
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // already gone
      }
    }
    clients.clear()
    try {
      rmSync(file, { force: true })
    } catch {
      // best effort: a stale token file is replaced on the next start
    }
  }
}
