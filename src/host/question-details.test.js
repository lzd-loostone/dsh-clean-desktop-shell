/** Question-batch capture unit tests (node:test; run: node src/host/question-details.test.js). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureQuestionBatch,
  removeQuestionBatch,
  questionBatchesForWrite,
  Q_TEXT_MAX,
  Q_MAX_PAGES,
  Q_MAX_OPTIONS,
} from './question-details.js'

const NOW = 1700000000000

function batch(questions) {
  return { questions, agent: { id: 'a' }, signal: { aborted: false } }
}

test('faithful single question keeps full fidelity', () => {
  const list = []
  const h = captureQuestionBatch(list, batch([{
    id: 'q1', question: '选个模式', header: 'Choose Mode',
    options: [{ label: 'A', description: 'x' }, { label: 'B' }],
  }]), NOW)
  assert.ok(h)
  assert.equal(list.length, 1)
  assert.equal(h.uiOnly, false)
  assert.equal(h.n, 1)
  assert.equal(h.since, NOW)
  assert.deepEqual(h.pages, [{ id: 'q1', q: '选个模式', header: 'Choose Mode', opts: ['A', 'B'] }])
})

test('multiSelect and plan-review flags project', () => {
  const list = []
  captureQuestionBatch(list, batch([
    { id: 'a', question: 'Q', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
  ]), NOW)
  captureQuestionBatch(list, batch([
    { id: 'p', question: 'Review', detail: '# Plan markdown', options: [{ label: 'Approve' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Approve' } },
  ]), NOW)
  assert.equal(list[0].pages[0].multi, true)
  assert.equal(list[0].uiOnly, false)
  assert.equal(list[1].pages[0].plan, true)
  assert.equal(list[1].pages[0].detail, '# Plan markdown')
  assert.equal(list[1].uiOnly, false)
})

test('multi-question batch stays answerable within page cap', () => {
  const list = []
  const qs = Array.from({ length: 3 }, (_, i) => ({ id: 'q' + i, question: 'Q' + i, options: [{ label: 'L' }] }))
  const h = captureQuestionBatch(list, batch(qs), NOW)
  assert.equal(h.n, 3)
  assert.equal(h.pages.length, 3)
  assert.equal(h.uiOnly, false)
})

test('oversized batch truncates pages and flips uiOnly', () => {
  const list = []
  const qs = Array.from({ length: Q_MAX_PAGES + 2 }, (_, i) => ({ id: 'q' + i, question: 'Q' + i }))
  const h = captureQuestionBatch(list, batch(qs), NOW)
  assert.equal(h.n, Q_MAX_PAGES + 2)
  assert.equal(h.pages.length, Q_MAX_PAGES)
  assert.equal(h.uiOnly, true)
})

test('too many options flips uiOnly and clips the preview', () => {
  const list = []
  const opts = Array.from({ length: Q_MAX_OPTIONS + 1 }, (_, i) => ({ label: 'o' + i }))
  const h = captureQuestionBatch(list, batch([{ id: 'q', question: 'Q', options: opts }]), NOW)
  assert.equal(h.uiOnly, true)
  assert.equal(h.pages[0].opts.length, Q_MAX_OPTIONS)
})

test('long labels clip for display and flip uiOnly (echo would be lossy)', () => {
  const list = []
  const label = 'x'.repeat(200)
  const h = captureQuestionBatch(list, batch([{ id: 'q', question: 'Q', options: [{ label }] }]), NOW)
  assert.equal(h.uiOnly, true)
  assert.ok(h.pages[0].opts[0].length < label.length)
  assert.ok(h.pages[0].opts[0].endsWith('…'))
})

test('long question/detail text clips cosmetically without uiOnly', () => {
  const list = []
  const h = captureQuestionBatch(list, batch([{ id: 'q', question: '长'.repeat(500), detail: 'd'.repeat(900), options: [{ label: 'ok' }] }]), NOW)
  assert.equal(h.pages[0].q, '长'.repeat(Q_TEXT_MAX) + '…')
  assert.equal(h.uiOnly, false) // display caps do not affect the answer
})

test('missing id / missing question text / empty label flip uiOnly', () => {
  const list = []
  assert.equal(captureQuestionBatch(list, batch([{ question: 'no id' }]), NOW).uiOnly, true)
  assert.equal(captureQuestionBatch(list, batch([{ id: 'x' }]), NOW).uiOnly, true)
  assert.equal(captureQuestionBatch(list, batch([{ id: 'x', question: 'Q', options: [{ label: '' }] }]), NOW).uiOnly, true)
})

test('free-text question without options stays answerable (custom text)', () => {
  const list = []
  const h = captureQuestionBatch(list, batch([{ id: 'q', question: '起个名字' }]), NOW)
  assert.equal(h.uiOnly, false)
  assert.equal(h.pages[0].opts, undefined)
})

test('garbage requests: empty/null questions produce no handle', () => {
  const list = []
  assert.equal(captureQuestionBatch(list, batch([]), NOW), null)
  assert.equal(captureQuestionBatch(list, {}, NOW), null)
  assert.equal(captureQuestionBatch(list, null, NOW), null)
  assert.equal(captureQuestionBatch(list, batch('nope'), NOW), null)
  assert.equal(list.length, 0)
})

test('remove pairs by identity and reports misses', () => {
  const list = []
  const h1 = captureQuestionBatch(list, batch([{ id: 'a', question: 'A' }]), NOW)
  const h2 = captureQuestionBatch(list, batch([{ id: 'b', question: 'B' }]), NOW + 1)
  assert.equal(removeQuestionBatch(list, h1), true)
  assert.equal(list.length, 1)
  assert.equal(removeQuestionBatch(list, h1), false)
  assert.equal(removeQuestionBatch(list, { }), false)
  assert.equal(list[0], h2)
})

test('forWrite emits plain deep-copies, order preserved', () => {
  const list = []
  captureQuestionBatch(list, batch([{ id: 'a', question: 'A', options: [{ label: '1' }, { label: '2' }] }]), NOW)
  captureQuestionBatch(list, batch([{ id: 'b', question: 'B', multiSelect: true }]), NOW + 5)
  const out = questionBatchesForWrite(list)
  assert.deepEqual(out, [
    { since: NOW, n: 1, uiOnly: false, pages: [{ id: 'a', q: 'A', header: undefined, detail: undefined, multi: undefined, plan: undefined, opts: ['1', '2'] }] },
    { since: NOW + 5, n: 1, uiOnly: false, pages: [{ id: 'b', q: 'B', header: undefined, detail: undefined, multi: true, plan: undefined, opts: undefined }] },
  ])
  out[0].pages[0].q = 'MUTATED'
  assert.equal(list[0].pages[0].q, 'A') // copy, not alias of the live tree via mutation of pages? (shallow per-page copy by literal)
})
