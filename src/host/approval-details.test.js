/**
 * Unit tests: src/host/approval-details.js (node:test, zero deps).
 * Run: node src/host/approval-details.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REASON_MAX,
  pushApprovalDetail,
  removeApprovalDetail,
  approvalDetailsForWrite,
} from './approval-details.js'

test('push normalizes a full request', () => {
  const list = []
  const d = pushApprovalDetail(list, { toolName: 'pwsh', reason: '要跑 rm 命令' }, 1000)
  assert.equal(list.length, 1)
  assert.equal(d, list[0])
  assert.deepEqual({ ...d }, { toolName: 'pwsh', reason: '要跑 rm 命令', since: 1000 })
})

test('push falls back on missing/non-string toolName', () => {
  const list = []
  const d1 = pushApprovalDetail(list, {}, 2)
  assert.equal(d1.toolName, '未知工具')
  const d2 = pushApprovalDetail(list, { toolName: '' }, 3)
  assert.equal(d2.toolName, '未知工具')
  const d3 = pushApprovalDetail(list, { toolName: 42 }, 4)
  assert.equal(d3.toolName, '未知工具')
})

test('push drops non-string or empty reason to undefined', () => {
  const list = []
  assert.equal(pushApprovalDetail(list, { toolName: 't', reason: '' }, 1).reason, undefined)
  assert.equal(pushApprovalDetail(list, { toolName: 't', reason: 5 }, 1).reason, undefined)
  assert.equal(pushApprovalDetail(list, { toolName: 't' }, 1).reason, undefined)
})

test('push truncates oversized reason to REASON_MAX + ellipsis', () => {
  const list = []
  const long = 'x'.repeat(REASON_MAX + 50)
  const d = pushApprovalDetail(list, { toolName: 't', reason: long }, 1)
  assert.equal(d.reason.length, REASON_MAX + 1)
  assert.ok(d.reason.endsWith('…'))
  assert.ok(d.reason.startsWith('x'))
})

test('push tolerates null request and bad now', () => {
  const list = []
  const before = Date.now()
  const d = pushApprovalDetail(list, null, NaN)
  assert.equal(d.toolName, '未知工具')
  assert.ok(d.since >= before)
})

test('remove matches by identity, first occurrence only', () => {
  const list = []
  const a = pushApprovalDetail(list, { toolName: 'same' }, 1)
  const b = pushApprovalDetail(list, { toolName: 'same' }, 2)
  assert.equal(removeApprovalDetail(list, a), true)
  assert.equal(list.length, 1)
  assert.equal(list[0], b)
})

test('remove of unknown handle is false', () => {
  const list = []
  const a = pushApprovalDetail(list, { toolName: 'x' }, 1)
  const ghost = { toolName: 'x', reason: undefined, since: 1 }
  assert.equal(removeApprovalDetail(list, ghost), false)
  assert.equal(list.length, 1)
  assert.equal(removeApprovalDetail(list, a), true)
  assert.equal(removeApprovalDetail(list, a), false) // double settle safe
})

test('forWrite returns plain copies, order kept', () => {
  const list = []
  const a = pushApprovalDetail(list, { toolName: 'first', reason: 'r1' }, 10)
  pushApprovalDetail(list, { toolName: 'second' }, 20)
  const out = approvalDetailsForWrite(list)
  assert.notEqual(out[0], a)
  assert.deepEqual(out, [
    { toolName: 'first', reason: 'r1', since: 10 },
    { toolName: 'second', reason: undefined, since: 20 },
  ])
  out[0].toolName = 'mutated'
  assert.equal(list[0].toolName, 'first') // copy, not live handle
})

test('forWrite of empty list is empty array', () => {
  assert.deepEqual(approvalDetailsForWrite([]), [])
})
