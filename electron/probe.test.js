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
import { probe } from './probe.js'

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

test('answering late is a miss, and the budget is honoured', async () => {
  const { server, url } = await listen((_req, _res) => {
    /* never answer — the request just hangs */
  })
  try {
    const started = Date.now()
    assert.equal(await probe(url, 200), false)
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
