/**
 * Unit tests for ready-line.js — run with: node --test electron/ready-line.test.js
 *
 * The bug this pins down: the shell treated the first loopback URL in the
 * backend's output as its window target, so billion-context's startup banner
 * ("model channel pinned to http://127.0.0.1:<random port>") sent the window
 * to that plugin's settings panel — and then offline once the ephemeral port
 * died — while dsh was up on its own port.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReadyUrl } from './ready-line.js'

const PORT = 3080
const READY = 'dsh web: http://127.0.0.1:3080/?token=abc_DEF-123 (LAN: http://192.168.19.97:3080/?token=abc_DEF-123)\r\n'

test('a plugin banner printed first never wins', () => {
  const banner = 'bili-native-dsh: model channel pinned to http://127.0.0.1:50132 \u2014 rebinding bili tools there\n'
  assert.equal(parseReadyUrl(banner + READY, PORT), 'http://127.0.0.1:3080/?token=abc_DEF-123')
})

test('the ready line alone wins: token kept, LAN hint dropped', () => {
  assert.equal(parseReadyUrl(READY, PORT), 'http://127.0.0.1:3080/?token=abc_DEF-123')
})

test('a ready line still arriving is not adopted (token must not be cut)', () => {
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3080/?token=abc', PORT), null)
})

test('a ready line on another port is accepted (dsh chose that port)', () => {
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:50132/\r\n', PORT), 'http://127.0.0.1:50132/')
})

test('a bare pre-0.1.2 line on the supervised port is accepted', () => {
  assert.equal(parseReadyUrl('listening on http://127.0.0.1:3080\n', PORT), 'http://127.0.0.1:3080')
})

test('a bare loopback URL on a foreign port is rejected', () => {
  assert.equal(parseReadyUrl('billion-context panel: http://127.0.0.1:7890/mcp\n', PORT), null)
  assert.equal(parseReadyUrl('http://127.0.0.1:30801\n', PORT), null)
})

test('nothing trustworthy parses to null', () => {
  assert.equal(parseReadyUrl('', PORT), null)
  assert.equal(parseReadyUrl(undefined, PORT), null)
  assert.equal(parseReadyUrl('http://127.0.0.1:3080\n', 0), null)
})
