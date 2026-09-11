/** Orb-geometry unit tests (node:test; run: node electron/orb-geometry.test.js). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orbArea, orbWinX, orbWinY, clamp, ORB_DEFAULT, ORB_MIN, ORB_MAX } from './orb-geometry.js'

const WA = { x: 0, y: 0, width: 1920, height: 1080 }
const WA2 = { x: 1920, y: 0, width: 2560, height: 1440 }
const M = 8

test('orbArea clamps diameter and applies margin twice', () => {
  assert.equal(orbArea({ orbSize: 56 }, M), 56 + 16)
  assert.equal(orbArea({ orbSize: 10 }, M), ORB_MIN + 16)
  assert.equal(orbArea({ orbSize: 500 }, M), ORB_MAX + 16)
  assert.equal(orbArea({ orbSize: NaN }, M), ORB_DEFAULT + 16)
  assert.equal(orbArea({ orbSize: '64' }, M), ORB_DEFAULT + 16) // strings are not numbers
  assert.equal(orbArea(undefined, M), ORB_DEFAULT + 16)
  assert.equal(orbArea({}, undefined), ORB_DEFAULT + 16)
})

test('orbWinX snap mode docks at the edge', () => {
  const cfg = { edgeSnap: true, orbSize: 56 }
  assert.equal(orbWinX(cfg, WA, 'right', null, M), 1920 - 72)
  assert.equal(orbWinX(cfg, WA, 'left', null, M), 0)
  assert.equal(orbWinX(cfg, WA2, 'right', null, M), 1920 + 2560 - 72)
})

test('orbWinX free mode uses pos.x, falls back to right edge', () => {
  const cfg = { edgeSnap: false, orbSize: 56 }
  assert.equal(orbWinX(cfg, WA, 'right', { x: 500, y: 10 }, M), 500)
  assert.equal(orbWinX(cfg, WA, 'right', null, M), 1920 - 72)
  assert.equal(orbWinX(cfg, WA, 'right', { x: NaN, y: 10 }, M), 1920 - 72)
  assert.equal(orbWinX(cfg, WA, 'right', { y: 10 }, M), 1920 - 72) // undefined x
  assert.equal(orbWinX(cfg, WA, 'right', { x: -9999 }, M), 0)
  assert.equal(orbWinX(cfg, WA, 'right', { x: 99999 }, M), 1920 - 72)
})

test('orbWinY snap mode honors anchorY and defaults near top', () => {
  const cfg = { edgeSnap: true, orbSize: 56 }
  assert.equal(orbWinY(cfg, WA, 300, null, M), 300)
  assert.equal(orbWinY(cfg, WA, null, null, M), 16)
  assert.equal(orbWinY(cfg, WA, NaN, null, M), 16)
  assert.equal(orbWinY(cfg, WA, 'abc', null, M), 16)
  assert.equal(orbWinY(cfg, WA, 100000, null, M), 1080 - 72)
})

test('orbWinY free mode prefers pos.y then anchorY then default', () => {
  const cfg = { edgeSnap: false, orbSize: 56 }
  assert.equal(orbWinY(cfg, WA, 300, { x: 5, y: 400 }, M), 400)
  assert.equal(orbWinY(cfg, WA, 300, { x: 5, y: NaN }, M), 300)
  assert.equal(orbWinY(cfg, WA, null, { x: 5 }, M), 16)
  assert.equal(orbWinY(cfg, WA, NaN, { x: 5, y: NaN }, M), 16) // BOTH NaN — the crash case
})

test('every output stays a finite integer even on total garbage', () => {
  const junkCfg = { orbSize: {}, edgeSnap: 1 }
  const junkWa = {}
  for (const [x, y] of [
    [orbWinX(junkCfg, junkWa, 'right', { x: undefined }, junkWa.x), orbWinY(junkCfg, junkWa, Infinity, { y: -Infinity }, undefined)],
    [orbWinX(null, null, null, null, null), orbWinY(null, null, null, null, null)],
  ]) {
    assert.ok(Number.isFinite(x) && Number.isInteger(x), 'x=' + x)
    assert.ok(Number.isFinite(y) && Number.isInteger(y), 'y=' + y)
  }
})

test('clamp passes through', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
})
