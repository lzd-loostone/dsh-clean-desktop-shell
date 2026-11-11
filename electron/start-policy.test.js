/**
 * Unit tests: electron/start-policy.js (node:test, zero deps, no Electron).
 *
 * The decisions here are the ones that used to be buried in the Electron
 * service: whether an already-listening backend is usable, when a restart is
 * the only way to obtain a launch token, and how many spawn attempts a start
 * is worth. They are pure so they can be pinned without a real backend.
 *
 * Run: node --test electron/start-policy.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStartPlan, shouldRetrySpawn, shouldAbortSpawn } from './start-policy.js'

test('an unauthenticated backend is reused, never restarted under the user', () => {
  assert.equal(
    decideStartPlan({ health: 'unauthenticated', hasOwnChild: false, hasToken: false }),
    'reuse',
  )
})

test('our own healthy child with a token is reused', () => {
  assert.equal(decideStartPlan({ health: 'ok', hasOwnChild: true, hasToken: true }), 'reuse')
})

test('a healthy external backend without a token is reused too', () => {
  assert.equal(decideStartPlan({ health: 'ok', hasOwnChild: false, hasToken: false }), 'reuse')
})

test('a dead port spawns, and an unhealthy answer spawns too', () => {
  assert.equal(decideStartPlan({ health: 'down', hasOwnChild: false, hasToken: false }), 'spawn')
  assert.equal(decideStartPlan({ health: 'unhealthy', hasOwnChild: false, hasToken: false }), 'spawn')
})

test('exactly one retry is allowed', () => {
  assert.equal(shouldRetrySpawn(1), true)
  assert.equal(shouldRetrySpawn(2), false)
})

test('a port that would not clear aborts the spawn instead of starting a second backend', () => {
  assert.equal(shouldAbortSpawn(false), true)
  assert.equal(shouldAbortSpawn(true), false)
})
