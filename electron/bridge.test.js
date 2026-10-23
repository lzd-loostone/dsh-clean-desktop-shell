/**
 * Unit tests: electron/bridge.js (node:test, zero deps, no Electron runtime).
 *
 * The shell can no longer push decisions into a window it owns; it POSTs them
 * to the token-gated route the host half registered. These tests pin the
 * wire contract against a real local http server: header, body, delivered
 * count, and the soft-fail paths (no handshake file, server rejects).
 *
 * Run: node electron/bridge.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendDecision } from './bridge.js'

/** Run a throwaway server; handler decides the response. */
function serve(handler) {
  return new Promise((resolve) => {
    const hits = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const hit = { method: req.method, url: req.url, headers: req.headers, body }
        hits.push(hit)
        handler(hit, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ hits, url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

/** Point the shell at a scratch DSH home holding the handshake file. */
function installHandshake(url, token) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shell-decide-'))
  writeFileSync(join(home, 'desktop-shell-bridge.json'), JSON.stringify({ url, token }), 'utf8')
  process.env.DSH_HOME = home
  return home
}

test('posts the decision with the token header and returns the delivered count', async () => {
  const srv = await serve((hit, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ delivered: 1 }))
  })
  installHandshake(srv.url, 'secret-token')
  const delivered = await sendDecision({ type: 'goto', sessionId: 'S1' })
  assert.equal(delivered, 1)
  assert.equal(srv.hits.length, 1)
  assert.equal(srv.hits[0].method, 'POST')
  assert.equal(srv.hits[0].url, '/dsh-clean-desktop-shell/decide')
  assert.equal(srv.hits[0].headers['x-shell-token'], 'secret-token')
  assert.deepEqual(JSON.parse(srv.hits[0].body), { type: 'goto', sessionId: 'S1' })
  await srv.close()
})

test('no handshake file → 0, nothing sent', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-shell-empty-'))
  assert.equal(await sendDecision({ type: 'goto', sessionId: 'S1' }), 0)
})

test('server rejection (403) → 0 without throwing', async () => {
  const srv = await serve((hit, res) => { res.writeHead(403).end('{}') })
  installHandshake(srv.url, 'wrong')
  assert.equal(await sendDecision({ type: 'approve', sessionId: 'S1', decision: 'allow' }), 0)
  await srv.close()
})
