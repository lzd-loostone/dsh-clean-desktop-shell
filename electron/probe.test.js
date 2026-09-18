/**
 * Unit tests for probe.js — run with: node --test electron/probe.test.js
 *
 * The flicker this pins down: one late answer used to be read as "backend
 * dead" and tore down a live page. So assert what counts as a death.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { probe, probeDetail } from './probe.js'

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
    assert.deepEqual(await probeDetail(url, 1000), { alive: true, fatal: false, why: 'HTTP 401' })
    assert.equal(await probe(url, 1000), true)
  } finally {
    server.close()
  }
})

test('a 5xx answer is a miss but never a death', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(502)
    res.end()
  })
  try {
    const r = await probeDetail(url, 1000)
    assert.equal(r.alive, false)
    assert.equal(r.fatal, false)
    assert.equal(r.why, 'HTTP 502')
  } finally {
    server.close()
  }
})

test('answering late is a miss, not a death (starved process)', async () => {
  const { server, url } = await listen((_req, _res) => {
    /* never answer — the request just hangs */
  })
  try {
    const started = Date.now()
    const r = await probeDetail(url, 200)
    assert.equal(r.alive, false)
    assert.equal(r.fatal, false, 'a timeout must not be read as a dead backend')
    assert.match(r.why, /TIMEOUT|ABORT/i)
    assert.ok(Date.now() - started < 2000, 'the probe budget must be honoured')
  } finally {
    server.close()
    // Drop the hung keep-alive-less socket so the test process can exit.
  }
})

test('nothing listening on the port is a death', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(204)
    res.end()
  })
  const closed = new Promise((resolve) => server.close(resolve))
  await once(server, 'close')
  await closed
  const r = await probeDetail(url, 1000)
  assert.equal(r.alive, false)
  assert.equal(r.fatal, true, 'ECONNREFUSED is the one answer that proves death')
  assert.equal(r.why, 'ECONNREFUSED')
})
