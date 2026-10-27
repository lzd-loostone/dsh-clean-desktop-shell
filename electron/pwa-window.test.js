/**
 * Unit tests: electron/pwa-window.js (node:test, zero deps).
 *
 * The PWA window has no queryable app identity — Chrome exposes nothing on the
 * HWND that says "this is the installed DSH app". The title is the only signal
 * that survives, and it changes with the open session, so the matcher is
 * pinned here rather than discovered at runtime.
 *
 * Run: node electron/pwa-window.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickPwaWindow, focusWindow, buildAppLaunchArgs, findPwaApp, waitForNewPwaWindow } from './pwa-window.js'

const win = (hwnd, title, extra = {}) => ({ hwnd, pid: 100, title, className: 'Chrome_WidgetWin_1', ...extra })

test('recognises the fullscreen PWA window by its title', () => {
  const got = pickPwaWindow([win(7, 'DeepSeek Harness - 拉取插件最新代码 — DeepSeek Harness')], 1)
  assert.deepEqual(got, { hwnd: 7, pid: 100 })
})

test('ignores a normal browser tab that happens to show DSH', () => {
  assert.equal(pickPwaWindow([win(8, 'DeepSeek Harness - 拉取插件最新代码 - Google Chrome')], 1), null)
})

test('ignores a normal tab in other Chromium browsers too', () => {
  assert.equal(pickPwaWindow([win(11, 'DeepSeek Harness - 会话 - Microsoft Edge')], 1), null)
  assert.equal(pickPwaWindow([win(12, 'DeepSeek Harness - 会话 - ego')], 1), null)
  assert.equal(pickPwaWindow([win(13, 'DeepSeek Harness - 会话 - Brave')], 1), null)
})

test('recognises the ego lite PWA window (same class, no browser suffix)', () => {
  assert.deepEqual(pickPwaWindow([win(14, 'DeepSeek Harness - 后台拔麦会触发关闭吗 (1) — DeepSeek Harness')], 1), { hwnd: 14, pid: 100 })
})

test('ignores our own Electron windows', () => {
  assert.equal(pickPwaWindow([win(9, 'DSH 气泡窗', { pid: 1 })], 1), null)
})

test('ignores non-Chromium window classes', () => {
  assert.equal(pickPwaWindow([win(10, 'DeepSeek Harness', { className: 'Notepad' })], 1), null)
})

test('focusWindow rejects a bogus handle instead of throwing', async () => {
  assert.equal(await focusWindow(0), false)
})

test('buildAppLaunchArgs pins profile and app id', () => {
  assert.deepEqual(buildAppLaunchArgs('abc123', 'Default'), ['--profile-directory=Default', '--app-id=abc123'])
})

test('findPwaApp scans Web Applications for the DSH icon', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-'))
  const dir = join(root, 'Default', 'Web Applications', '_crx_hgiemfgfjhalibdoboikeiepnnjapnpc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'DeepSeek Harness.ico'), '')
  assert.deepEqual(findPwaApp(root), { appId: 'hgiemfgfjhalibdoboikeiepnnjapnpc', profileDir: 'Default' })
})

test('findPwaApp returns null when the PWA is not installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-empty-'))
  assert.equal(findPwaApp(root), null)
})

test('waitForNewPwaWindow gives up after the deadline', async () => {
  const got = await waitForNewPwaWindow(new Set([1]), 50, { intervalMs: 10, scan: () => ({ hwnd: 1, pid: 9 }) })
  assert.equal(got, null)
})

test('waitForNewPwaWindow returns a handle that was not there before', async () => {
  let n = 0
  const scan = () => (++n > 2 ? { hwnd: 42, pid: 9 } : null)
  assert.equal(await waitForNewPwaWindow(new Set(), 500, { intervalMs: 10, scan }), 42)
})
