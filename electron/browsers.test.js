/**
 * Unit tests: electron/browsers.js (node:test, zero deps).
 *
 * The PWA window belongs to whichever Chromium browser installed it, and the
 * user may have several. The rule is: the Windows default browser wins when it
 * has the app, otherwise the first browser that does. Both inputs (the installed
 * launchers, the registry value) are injected so the choice is pinned here.
 *
 * Run: node electron/browsers.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserDefinitions, detectBrowsers, parseDefaultProgId, chooseBrowser } from './browsers.js'

const env = {
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}

const chrome = {
  id: 'chrome',
  name: 'Chrome',
  progIds: ['ChromeHTML'],
  proxy: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe',
  userData: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data',
  tabSuffix: / - Google Chrome$/,
}
const ego = {
  id: 'ego',
  name: 'ego lite',
  progIds: [],
  proxy: 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\chrome_proxy.exe',
  userData: 'C:\\Users\\u\\AppData\\Local\\Citro Labs\\ego lite\\User Data',
  tabSuffix: / - ego$/,
}

test('browserDefinitions resolves Chrome paths from the environment', () => {
  const defs = browserDefinitions(env)
  const found = defs.find((b) => b.id === 'chrome')
  assert.equal(found.proxy, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe')
  assert.equal(found.userData, 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data')
  assert.ok(found.progIds.includes('ChromeHTML'))
})

test('browserDefinitions resolves Edge and ego lite too', () => {
  const defs = browserDefinitions(env)
  assert.ok(defs.some((b) => b.id === 'edge' && b.progIds.includes('MSEdgeHTM')))
  assert.ok(defs.some((b) => b.id === 'ego' && b.name === 'ego lite'))
})

test('detectBrowsers keeps only browsers whose launcher exists', () => {
  const defs = browserDefinitions(env)
  const got = detectBrowsers(defs, (p) => p.includes('Chrome'))
  assert.deepEqual(got.map((b) => b.id), ['chrome'])
})

test('parseDefaultProgId reads the ProgId out of reg query output', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n\r\n'
  assert.equal(parseDefaultProgId(out), 'ChromeHTML')
})

test('parseDefaultProgId returns null for garbage', () => {
  assert.equal(parseDefaultProgId(''), null)
  assert.equal(parseDefaultProgId('no progid here'), null)
})

test('chooseBrowser prefers the default browser when it has the app', () => {
  assert.equal(chooseBrowser([ego, chrome], 'ChromeHTML').id, 'chrome')
})

test('chooseBrowser falls back to the first browser with the app', () => {
  assert.equal(chooseBrowser([ego, chrome], 'MSEdgeHTM').id, 'ego')
})

test('chooseBrowser returns null when no browser has the app', () => {
  assert.equal(chooseBrowser([], 'ChromeHTML'), null)
})
