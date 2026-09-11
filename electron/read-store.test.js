/**
 * Unit tests for read-store.js — run with: node --test electron/read-store.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseReadData,
  serializeReadData,
  shouldMarkUnread,
  pruneReadMap,
  createReadStore,
  MAX_READ_ENTRIES,
} from './read-store.js'

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), 'dsh-read-store-')), name)
}

test('parseReadData: valid round-trip with serializeReadData', () => {
  const map = new Map([['a', 111], ['b', 222]])
  const parsed = parseReadData(serializeReadData(map))
  assert.deepEqual([...parsed.entries()], [['a', 111], ['b', 222]])
})

test('parseReadData: corrupt JSON yields empty map', () => {
  assert.equal(parseReadData('{not json').size, 0)
})

test('parseReadData: missing/garbage read field yields empty map', () => {
  assert.equal(parseReadData('{}').size, 0)
  assert.equal(parseReadData('{"read": "nope"}').size, 0)
  assert.equal(parseReadData('null').size, 0)
})

test('parseReadData: non-finite values are dropped, valid kept', () => {
  const m = parseReadData(JSON.stringify({ read: { a: 5, b: 'x', c: null, d: 1e999, e: 7 } }))
  assert.deepEqual([...m.entries()].sort(), [['a', 5], ['e', 7]])
})

test('shouldMarkUnread: never-read lights; read at same/later mark stays dark; newer completion re-lights', () => {
  const marks = new Map([['x', 1000]])
  assert.equal(shouldMarkUnread(marks, 'fresh', undefined, 9999), true)   // never read
  assert.equal(shouldMarkUnread(marks, 'x', 1000, 2000), false)           // re-observed same edge
  assert.equal(shouldMarkUnread(marks, 'x', 900, 2000), false)            // older finishedAt
  assert.equal(shouldMarkUnread(marks, 'x', 1001, 2000), true)            // genuinely new run
})

test('shouldMarkUnread: absent finishedAt falls back to now (strictly later re-lights, same instant does not)', () => {
  const marks = new Map([['x', 1000]])
  assert.equal(shouldMarkUnread(marks, 'x', undefined, 1000), false)
  assert.equal(shouldMarkUnread(marks, 'x', undefined, 1001), true)
  assert.equal(shouldMarkUnread(marks, 'x', NaN, 1001), true)
})

test('pruneReadMap: drops ids not active, keeps active ones', () => {
  const m = new Map([['a', 1], ['b', 2], ['c', 3]])
  pruneReadMap(m, ['a', 'c'])
  assert.deepEqual([...m.keys()].sort(), ['a', 'c'])
})

test('pruneReadMap: caps at max by dropping oldest readAt', () => {
  const m = new Map([['old', 1], ['mid', 2], ['new', 3]])
  pruneReadMap(m, ['old', 'mid', 'new'], 2)
  assert.deepEqual([...m.keys()].sort(), ['mid', 'new'])
})

test('createReadStore: load with missing file is empty and does not throw', () => {
  const s = createReadStore(tmpFile('absent.json'))
  assert.equal(s.load().size, 0)
})

test('createReadStore: markRead persists and reload returns the mark', () => {
  const file = tmpFile('r.json')
  let clock = 1234
  const s = createReadStore(file, { now: () => clock })
  s.load()
  s.markRead('sess-1')
  const onDisk = parseReadData(readFileSync(file, 'utf8'))
  assert.equal(onDisk.get('sess-1'), 1234)
  const s2 = createReadStore(file, { now: () => clock })
  s2.load()
  assert.equal(s2.isRead('sess-1', 1000), true)   // older completion stays dark
  clock = 5000
  assert.equal(s2.isRead('sess-1', 1234), true)   // equal timestamp: no re-light
  assert.equal(s2.isRead('sess-1', 5001), false)  // newer run lights again
})

test('createReadStore: markAll records one timestamp for all ids and saves once', () => {
  const file = tmpFile('all.json')
  const s = createReadStore(file, { now: () => 777 })
  s.load()
  s.markAll(['a', 'b', '', null, 'c'])
  const onDisk = parseReadData(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk.get('a'), 777)
  assert.deepEqual(onDisk.get('c'), 777)
  assert.equal(onDisk.has(''), false)
  assert.equal(onDisk.has(null), false)
})

test('createReadStore: invalid ids never enter the map', () => {
  const s = createReadStore(tmpFile('inv.json'))
  s.load()
  s.markRead(undefined)
  s.markRead(42)
  s.markRead('')
  assert.equal(s.marks().size, 0)
})

test('createReadStore: prune removes ids gone from state and persists', () => {
  const file = tmpFile('p.json')
  const s = createReadStore(file)
  s.load()
  s.markAll(['keep', 'gone'])
  s.prune(['keep'])
  assert.equal(s.marks().has('gone'), false)
  assert.equal(parseReadData(readFileSync(file, 'utf8')).has('gone'), false)
})

test('createReadStore: save failure is swallowed, later mutations retry', () => {
  // Path inside a non-existent directory → writeFileSync throws ENOENT, caught.
  const bad = join(tmpdir(), 'dsh-definitely-missing-dir-9b1e', 'r.json')
  const s = createReadStore(bad)
  s.load()
  assert.doesNotThrow(() => s.markRead('x'))       // swallowed
  assert.equal(s.isRead('x', 1), true)            // memory still correct
})

test('createReadStore: load tolerates a corrupt file and next save heals it', () => {
  const file = tmpFile('corrupt.json')
  writeFileSync(file, '}{garbage', 'utf8')
  const s = createReadStore(file)
  assert.equal(s.load().size, 0)
  s.markRead('healed')
  assert.ok(parseReadData(readFileSync(file, 'utf8')).has('healed'))
})

test('MAX_READ_ENTRIES is a sane positive cap', () => {
  assert.ok(Number.isInteger(MAX_READ_ENTRIES) && MAX_READ_ENTRIES > 0)
})
