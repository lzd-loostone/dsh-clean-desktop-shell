/**
 * Unit tests: electron/approval-view.js (node:test, zero deps).
 * Run: node electron/approval-view.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_W,
  APPROVAL_GAP,
  APPROVAL_H_MIN,
  APPROVAL_H_MAX,
  pickApprovalInfo,
  computeApprovalBounds,
  approvalAgeLabel,
} from './approval-view.js'

test('pickApprovalInfo: no field / bad shapes → null', () => {
  assert.equal(pickApprovalInfo(undefined), null)
  assert.equal(pickApprovalInfo(null), null)
  assert.equal(pickApprovalInfo({}), null)
  assert.equal(pickApprovalInfo({ pendingApprovals: 'nope' }), null)
  assert.equal(pickApprovalInfo({ pendingApprovals: [] }), null)
})

test('pickApprovalInfo: first entry wins, more counts the rest', () => {
  const s = {
    lastChangeAt: 111,
    pendingApprovals: [
      { toolName: 'pwsh', reason: '删临时文件', since: 100 },
      { toolName: 'write', since: 120 },
      { toolName: 'read', since: 130 },
    ],
  }
  assert.deepEqual(pickApprovalInfo(s), { toolName: 'pwsh', reason: '删临时文件', since: 100, more: 2 })
})

test('pickApprovalInfo: broken first entry falls back, keeps count', () => {
  const s = { lastChangeAt: 222, pendingApprovals: [null, { toolName: 'x' }] }
  assert.deepEqual(pickApprovalInfo(s), { toolName: '未知工具', reason: undefined, since: 222, more: 1 })
})

test('pickApprovalInfo: non-string reason and bad since fall back', () => {
  const s = { lastChangeAt: 333, pendingApprovals: [{ toolName: 't', reason: 7, since: 'oops' }] }
  assert.deepEqual(pickApprovalInfo(s), { toolName: 't', reason: undefined, since: 333, more: 0 })
})

test('pickApprovalInfo: missing lastChangeAt → since 0', () => {
  const r = pickApprovalInfo({ pendingApprovals: [{ toolName: 't' }] })
  assert.equal(r.since, 0)
})

const WA = { x: 0, y: 0, width: 1920, height: 1080 }
const BUB_RIGHT = { x: 1560, y: 100, width: 312, height: 300 } // bubble right of orb
const BUB_LEFT = { x: 48, y: 100, width: 312, height: 300 } // bubble left of orb

test('bounds: room on the mount side → exact gap placement', () => {
  const mid = { x: 800, y: 100, width: 312, height: 300 }
  const b = computeApprovalBounds(mid, 236, WA, 'right')
  assert.equal(b.x, 800 + 312 + APPROVAL_GAP)
  assert.equal(b.width, APPROVAL_W)
  assert.equal(b.tail, 'left')
  const l = computeApprovalBounds({ x: 900, y: 100, width: 312, height: 300 }, 236, WA, 'left')
  assert.equal(l.x, 900 - APPROVAL_GAP - APPROVAL_W)
  assert.equal(l.tail, 'right')
})

test('bounds: bubble at screen edge → detail clamped into work area', () => {
  const b = computeApprovalBounds(BUB_RIGHT, 236, WA, 'right')
  assert.ok(b.x + APPROVAL_W <= WA.x + WA.width)
  assert.equal(b.x, WA.width - APPROVAL_W) // 1880+320 > 1920 → clamped to 1600
})

test('bounds: bubble left of orb → detail mounts left, tail points right', () => {
  const b = computeApprovalBounds(BUB_LEFT, 236, WA, 'left')
  assert.equal(b.tail, 'right')
  assert.equal(b.x, WA.x) // 48-8-320 < 0 → clamp
})

test('bounds: y aligns near bubble top, never above work area, fits height', () => {
  const tall = computeApprovalBounds(BUB_RIGHT, 420, WA, 'right')
  assert.equal(tall.height, 420)
  assert.equal(tall.y, 76) // taller than the 300px bubble → pulled up 24px
  assert.ok(tall.y >= WA.y)
  const low = computeApprovalBounds({ x: 100, y: 1000, width: 312, height: 300 }, 236, WA, 'right')
  assert.ok(low.y + low.height <= 1080)
})

test('bounds: height clamped to min/max', () => {
  assert.equal(computeApprovalBounds(BUB_RIGHT, 10, WA, 'right').height, APPROVAL_H_MIN)
  assert.equal(computeApprovalBounds(BUB_RIGHT, 9999, WA, 'right').height, APPROVAL_H_MAX)
})

test('age label: seconds, minutes, hours, guards', () => {
  assert.equal(approvalAgeLabel(1000, 9000), '8 秒前')
  assert.equal(approvalAgeLabel(0, 9000), '')
  assert.equal(approvalAgeLabel(NaN, 9000), '')
  assert.equal(approvalAgeLabel(10000, 9000), '') // now < since (clock skew)
  assert.equal(approvalAgeLabel(1000, 61000), '1 分钟前')
  assert.equal(approvalAgeLabel(1000, 1000 + 95000), '1 分 35 秒前')
  assert.equal(approvalAgeLabel(1000, 1000 + 7200000), '2 小时前')
  assert.equal(approvalAgeLabel(1000, 1000 + 7260000), '2 小时 1 分前')
})
