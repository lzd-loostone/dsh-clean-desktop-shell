/**
 * Unit tests for link-policy.js — run with: node electron/link-policy.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyUrl, canOpenExternally } from './link-policy.js'

test('classifyUrl: http/https open in the in-shell link window', () => {
  assert.deepEqual(classifyUrl('http://example.com/a?b=1'), { action: 'link-window', url: 'http://example.com/a?b=1' })
  assert.equal(classifyUrl('https://example.com').url, 'https://example.com/')
  assert.equal(classifyUrl('HTTPS://Example.COM/X').action, 'link-window') // protocol is case-folded by URL
})

test('classifyUrl: non-web schemes delegate to the system handler', () => {
  for (const u of ['mailto:a@b.c', 'tel:+123', 'sms:555', 'webcal://x/y', 'file:///C:/tmp/x.pdf'])
    assert.equal(classifyUrl(u).action, 'external', u)
})

test('classifyUrl: script-injection and opaque schemes are denied', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,<script></script>', 'blob:https://x/uuid', 'vbscript:x'])
    assert.equal(classifyUrl(u).action, 'deny', u)
})

test('classifyUrl: garbage input denied', () => {
  assert.equal(classifyUrl('').action, 'deny')
  assert.equal(classifyUrl('/relative/path').action, 'deny')
  assert.equal(classifyUrl('not a url').action, 'deny')
  assert.equal(classifyUrl(undefined).action, 'deny')
  assert.equal(classifyUrl(null).action, 'deny')
  assert.equal(classifyUrl(42).action, 'deny')
})

test('canOpenExternally: mirrors the external allowlist, rejects the rest', () => {
  assert.equal(canOpenExternally('https://ok.example'), true)
  assert.equal(canOpenExternally('mailto:x@y.z'), true)
  assert.equal(canOpenExternally('javascript:evil()'), false)
  assert.equal(canOpenExternally('data:text/html,hi'), false)
  assert.equal(canOpenExternally(''), false)
  assert.equal(canOpenExternally(undefined), false)
})
