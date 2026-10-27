/**
 * Unit tests: src/host/bridge.js (node:test, zero deps).
 *
 * The bridge is the only channel left for the task overlay's three actions
 * once the shell window is gone: SSE down, token-gated POST up. Everything
 * here runs against a fake web server, so the test pins the wire contract
 * (paths, frames, auth, delivery count) without booting dsh.
 *
 * Run: node src/host/bridge.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { startBridge, EVENTS_PATH, DECIDE_PATH, bridgeFilePath } from './bridge.js'

/** webServer stand-in: records exact routes, returns per-route unregister. */
function fakeServer() {
  const routes = new Map()
  return {
    routes,
    getOrigin: () => 'http://127.0.0.1:3080',
    register({ kind, path, handler }) {
      const key = kind + ':' + path
      routes.set(key, handler)
      return () => routes.delete(key)
    },
    handler(kind, path) {
      const h = routes.get(kind + ':' + path)
      assert.ok(h, 'route ' + kind + ' ' + path + ' must be registered')
      return h
    },
  }
}

function fakeRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.body = ''
  res.ended = false
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; return res }
  res.write = (chunk) => { res.body += String(chunk); return true }
  res.end = (chunk) => { if (chunk) res.body += String(chunk); res.ended = true; return res }
  return res
}

function fakeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = body === null ? new EventEmitter() : Readable.from([body])
  req.method = method
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-shell-bridge-'))
}

async function settle() {
  await new Promise((r) => setTimeout(r, 10))
}

async function connect(server, ctx) {
  const res = fakeRes()
  server.handler('exact', EVENTS_PATH)(fakeReq(), res)
  await settle()
  return res
}

test('registers both exact routes and writes the token file', () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  assert.ok(server.routes.has('exact:' + EVENTS_PATH))
  assert.ok(server.routes.has('exact:' + DECIDE_PATH))
  const info = JSON.parse(readFileSync(bridgeFilePath(home), 'utf8'))
  assert.equal(info.url, 'http://127.0.0.1:3080')
  assert.match(info.token, /^[0-9a-f]{32}$/)
  dispose()
})

test('SSE opens with event-stream headers and an initial comment', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const res = await connect(server)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['Content-Type']), /text\/event-stream/)
  assert.match(res.body, /^: connected/)
  dispose()
})

test('POST decision with the right token is broadcast to every SSE client', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const token = JSON.parse(readFileSync(bridgeFilePath(home), 'utf8')).token
  const a = await connect(server)
  const b = await connect(server)

  const res = fakeRes()
  server.handler('exact', DECIDE_PATH)(
    fakeReq({ method: 'POST', headers: { 'x-shell-token': token }, body: JSON.stringify({ type: 'goto', sessionId: 'S1' }) }),
    res,
  )
  await settle()

  const frame = 'data: ' + JSON.stringify({ type: 'goto', sessionId: 'S1' })
  assert.ok(a.body.includes(frame), 'client a receives the frame')
  assert.ok(b.body.includes(frame), 'client b receives the frame')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { delivered: 2 })
  dispose()
})

test('missing or wrong token → 403 and no broadcast', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const client = await connect(server)
  for (const headers of [{}, { 'x-shell-token': 'nope' }]) {
    const res = fakeRes()
    server.handler('exact', DECIDE_PATH)(
      fakeReq({ method: 'POST', headers, body: JSON.stringify({ type: 'goto', sessionId: 'S1' }) }),
      res,
    )
    await settle()
    assert.equal(res.statusCode, 403)
  }
  assert.ok(!client.body.includes('data:'), 'nothing was delivered')
  dispose()
})

test('non-POST and malformed payloads are rejected', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const token = JSON.parse(readFileSync(bridgeFilePath(home), 'utf8')).token
  const handler = server.handler('exact', DECIDE_PATH)

  const get = fakeRes()
  handler(fakeReq({ method: 'GET', headers: { 'x-shell-token': token } }), get)
  await settle()
  assert.equal(get.statusCode, 405)

  for (const body of ['not json', '{}', JSON.stringify({ type: 'bogus', sessionId: 'S1' }), JSON.stringify({ type: 'goto' })]) {
    const res = fakeRes()
    handler(fakeReq({ method: 'POST', headers: { 'x-shell-token': token }, body }), res)
    await settle()
    assert.equal(res.statusCode, 400, 'rejects ' + body)
  }
  dispose()
})

test('reload is accepted without a session id and broadcast', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const token = JSON.parse(readFileSync(bridgeFilePath(home), 'utf8')).token
  const a = await connect(server)

  const res = fakeRes()
  server.handler('exact', DECIDE_PATH)(
    fakeReq({ method: 'POST', headers: { 'x-shell-token': token }, body: JSON.stringify({ type: 'reload' }) }),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { delivered: 1 })
  assert.ok(a.body.includes('data: {"type":"reload"}'))
  dispose()
})

test('dispose closes SSE clients and removes the token file', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const client = await connect(server)
  dispose()
  assert.equal(client.ended, true)
  assert.equal(existsSync(bridgeFilePath(home)), false)
  assert.equal(server.routes.size, 0)
})
