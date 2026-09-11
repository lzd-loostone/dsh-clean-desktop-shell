/** Question-view display-model tests (run: node electron/question-view.test.js). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickQuestionInfo } from './question-view.js'

const PAGE = { id: 'a', q: 'A?', opts: ['x', 'y'] }

test('null on missing/foreign shape/empty list', () => {
  assert.equal(pickQuestionInfo(undefined), null)
  assert.equal(pickQuestionInfo(null), null)
  assert.equal(pickQuestionInfo({}), null)
  assert.equal(pickQuestionInfo({ pendingQuestions: [] }), null)
  assert.equal(pickQuestionInfo({ pendingQuestions: 'x' }), null)
})

test('first batch wins; later batches fold into more', () => {
  const s = {
    lastChangeAt: 111,
    pendingQuestions: [
      { since: 100, n: 2, uiOnly: false, pages: [PAGE, { id: 'b', q: 'B' }] },
      { since: 90, n: 1, uiOnly: false, pages: [PAGE] },
    ],
  }
  const info = pickQuestionInfo(s)
  assert.equal(info.since, 100)
  assert.equal(info.n, 2)
  assert.equal(info.uiOnly, false)
  assert.equal(info.pages.length, 2)
  assert.equal(info.more, 1)
})

test('garbage batch entry degrades to a safe read-only card model', () => {
  const info = pickQuestionInfo({ pendingQuestions: [null] })
  assert.deepEqual(info, { n: 0, uiOnly: true, pages: [], since: 0, more: 0 })
  const info2 = pickQuestionInfo({ pendingQuestions: [{ pages: 'nope' }], lastChangeAt: 55 })
  assert.equal(info2.since, 55)
  assert.equal(info2.pages.length, 0)
  assert.equal(info2.uiOnly, true)
})
