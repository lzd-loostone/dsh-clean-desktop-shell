/**
 * Unit tests: electron/backend-watch.js (node:test, zero deps, no Electron).
 *
 * A backend restart leaves every open page holding a dead socket, so the shell
 * has to notice the service came back and nudge the page to re-mount. These
 * tests pin the two rules that keep that nudge from being noise: only a real
 * down → up transition fires, and a backend that was already up never fires.
 *
 * Run: node electron/backend-watch.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchBackend, timedProbe } from './backend-watch.js'

test('fires onRestart only on a down → up transition', async () => {
  const states = [true, false, false, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? false, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.equal(fired, 1)
})

test('a backend that was already up at start never fires', async () => {
  let fired = 0
  const stop = watchBackend({ probe: async () => true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 30))
  stop()
  assert.equal(fired, 0)
})

test('stop() ends the polling', async () => {
  let probes = 0
  const stop = watchBackend({ probe: async () => { probes++; return true }, onRestart: () => {}, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 10))
  stop()
  const seen = probes
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(probes, seen)
})

test('one failed probe is not a down state', async () => {
  const states = [true, true, false, true, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.equal(fired, 0)
})

test('two consecutive failures then up fires once', async () => {
  const states = [true, false, false, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.equal(fired, 1)
})

test('timedProbe reports duration and result', async () => {
  const lines = []
  const traced = timedProbe(async () => true, (line) => lines.push(line))
  assert.equal(await traced('http://x/'), true)
  assert.match(lines[0], /^probe ok \d+ms http:\/\/x\/$/)
})

test('onChange reports the effective state, including the first probe', async () => {
  const seen = []
  const states = [true, false, false, true]
  const stop = watchBackend({
    probe: async () => states.shift() ?? true,
    onChange: (up) => seen.push(up),
    intervalMs: 1,
  })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.deepEqual(seen, [true, false, true])
})

test('a shell that starts before the backend still learns it came up', async () => {
  const seen = []
  const states = [false, false, true]
  const stop = watchBackend({
    probe: async () => states.shift() ?? true,
    onChange: (up) => seen.push(up),
    onRestart: () => {},
    intervalMs: 1,
  })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.deepEqual(seen, [false, true])
})
