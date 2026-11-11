/**
 * overlay-ring unit tests (node:test; run: node --test electron/overlay-ring.test.js).
 *
 * Both decisions live here, DOM-free, so the renderer only paints what these
 * functions return: the row-end child ring and the orb badge.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ringState, badgeState, ringLabel } from './overlay-ring.js'

test('ringState: no running children means no ring', () => {
  const st = ringState({ childrenRunning: 0 })
  assert.equal(st.visible, false)
  assert.equal(st.count, 0)
  assert.equal(st.tone, 'idle')
})

test('ringState: a small count renders as its own number', () => {
  const st = ringState({ childrenRunning: 3 })
  assert.equal(st.visible, true)
  assert.equal(st.count, 3)
  assert.equal(st.label, '3')
  assert.equal(st.tone, 'busy')
})

test('ringState: ten or more collapses to 9+', () => {
  assert.equal(ringState({ childrenRunning: 9 }).label, '9')
  assert.equal(ringState({ childrenRunning: 10 }).label, '9+')
  const many = ringState({ childrenRunning: 12 })
  assert.equal(many.count, 12)
  assert.equal(many.label, '9+')
})

test('ringLabel is the single source of the 9+ cap', () => {
  assert.equal(ringLabel(0), '0')
  assert.equal(ringLabel(9), '9')
  assert.equal(ringLabel(10), '9+')
  assert.equal(ringLabel(999), '9+')
  assert.equal(ringLabel(undefined), '0')
  assert.equal(ringLabel(-4), '0')
})

test('ringState: a pending request turns the ring amber, count unchanged', () => {
  const st = ringState({ childrenRunning: 2, approvals: 1 })
  assert.equal(st.tone, 'attention')
  assert.equal(st.label, '2')
  assert.equal(ringState({ childrenRunning: 2, questions: 1 }).tone, 'attention')
  assert.equal(ringState({ childrenRunning: 2, approvals: 0, questions: 0 }).tone, 'busy')
})

test('ringState: a child waiting for a human also turns the ring amber', () => {
  // The approval belongs to the child, but the row that owns it must say so.
  const st = ringState({ childrenRunning: 2, childrenPending: 1 })
  assert.equal(st.tone, 'attention')
  assert.equal(st.label, '2')
})

test('ringState: reduced motion degrades to the static branch', () => {
  assert.equal(ringState({ childrenRunning: 2 }).animated, true)
  assert.equal(ringState({ childrenRunning: 2 }, { reducedMotion: true }).animated, false)
  // ... but never hides the information
  assert.equal(ringState({ childrenRunning: 2 }, { reducedMotion: true }).visible, true)
})

test('ringState tolerates a missing row', () => {
  assert.equal(ringState(undefined).visible, false)
  assert.equal(ringState({}).visible, false)
})

test('badgeState: nothing live means no badge', () => {
  const st = badgeState([])
  assert.equal(st.visible, false)
  assert.equal(st.count, 0)
  assert.equal(st.tone, 'idle')
})

test('badgeState: counts live rows, collapses at ten', () => {
  const three = badgeState([{ live: true }, { live: true }, { live: true }, { live: false }])
  assert.equal(three.visible, true)
  assert.equal(three.count, 3)
  assert.equal(three.label, '3')
  assert.equal(three.tone, 'busy')

  const many = badgeState(Array.from({ length: 12 }, () => ({ live: true })))
  assert.equal(many.count, 12)
  assert.equal(many.label, '9+')
})

test('badgeState: a session waiting for a human counts as live', () => {
  const st = badgeState([
    { kind: 'approval', approvals: 1, running: false },
    { kind: 'running', running: true },
  ])
  assert.equal(st.count, 2)
  // Any pending request anywhere makes the badge amber.
  assert.equal(st.tone, 'attention')
})

test('badgeState: finished rows never count', () => {
  const st = badgeState([{ kind: 'done' }, { kind: 'done' }])
  assert.equal(st.visible, false)
  assert.equal(st.count, 0)
})

test('badgeState: orphan children keep the badge honest', () => {
  const st = badgeState([{ live: true }], { extraLive: 1 })
  assert.equal(st.count, 2)
  assert.equal(badgeState([], { extraLive: 0 }).visible, false)
})

test('badgeState: reduced motion degrades to the static branch', () => {
  assert.equal(badgeState([{ live: true }]).animated, true)
  assert.equal(badgeState([{ live: true }], { reducedMotion: true }).animated, false)
})
