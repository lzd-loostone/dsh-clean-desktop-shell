/**
 * Unit tests for probe.js — run with: node --test electron/probe.test.js
 *
 * The flicker this pins down: one late answer used to be read as "backend
 * dead". So assert which answers count as a live service.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { probe, probeOutcome, DEFAULT_PROBE_TIMEOUT_MS } from './probe.js'

async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' }
}

test('an HTTP answer below 5xx is alive (401 = token-gated root still counts)', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    assert.equal(await probe(url, 1000), true)
  } finally {
    server.close()
  }
})

test('a 5xx answer is a miss', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(502)
    res.end()
  })
  try {
    assert.equal(await probe(url, 1000), false)
  } finally {
    server.close()
  }
})

test('a late answer is a timeout, not a death, and the budget is honoured', async () => {
  const { server, url } = await listen((_req, _res) => {
    /* never answer — the request just hangs */
  })
  try {
    const started = Date.now()
    // A busy backend answers late while still serving the open page. Grading
    // that as down is what made the orb flash 后端未连接 and recover; the
    // honest verdict is "nothing proven", so `probe()` keeps the previous state.
    assert.equal((await probeOutcome(url, 200)).kind, 'timeout')
    assert.equal(await probe(url, 200), true)
    assert.ok(Date.now() - started < 2000, 'the probe budget must be honoured')
  } finally {
    server.close()
  }
})

test('nothing listening on the port is a miss', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(204)
    res.end()
  })
  const closed = new Promise((resolve) => server.close(resolve))
  await once(server, 'close')
  await closed
  assert.equal(await probe(url, 1000), false)
})

test('401 is alive but reported as unauthenticated', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    // A generous budget on purpose: this asserts the classification, and the
    // full suite runs these files in parallel (a starved loop would otherwise
    // turn a live server into a timeout).
    assert.deepEqual(await probeOutcome(url, 5000), { kind: 'unauthenticated', status: 401 })
    assert.equal(await probe(url, 5000), true)
  } finally {
    server.close()
  }
})

test('200 is ok and 502 is unhealthy', async () => {
  const ok = await listen((_req, res) => {
    res.writeHead(200)
    res.end()
  })
  const bad = await listen((_req, res) => {
    res.writeHead(502)
    res.end()
  })
  try {
    assert.equal((await probeOutcome(ok.url, 5000)).kind, 'ok')
    assert.equal((await probeOutcome(bad.url, 5000)).kind, 'unhealthy')
    assert.equal(await probe(bad.url, 5000), false)
  } finally {
    ok.server.close()
    bad.server.close()
  }
})

test('the default budget is three seconds', () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 3000)
})
