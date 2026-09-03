import assert from 'node:assert/strict'
import test from 'node:test'

import MarkdownIt from 'markdown-it'

import { configureSafeMarkdown, isSafeMarkdownLink } from './chat-markdown-security.mjs'

test('chat markdown rejects executable and app-internal URL schemes', () => {
  for (const url of [
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'asset://localhost/private',
    'tauri://localhost',
    '//example.com/path',
  ]) {
    assert.equal(isSafeMarkdownLink(url), false, url)
  }
})

test('chat markdown allows web, mail, anchor, and relative destinations', () => {
  for (const url of [
    'https://example.com/path',
    'http://localhost:3456/help',
    'mailto:user@example.com',
    '#heading',
    './guide.md',
    '../guide.md',
    '/help',
  ]) {
    assert.equal(isSafeMarkdownLink(url), true, url)
  }
})

test('raw HTML is escaped and unsafe markdown links are not emitted', () => {
  const md = configureSafeMarkdown(new MarkdownIt({ html: false, linkify: true }))
  const output = md.render('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)')

  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(output, /<img/)
  assert.doesNotMatch(output, /href="javascript:/)
  assert.match(output, /href="https:\/\/example\.com"/)
  assert.match(output, /rel="noopener noreferrer"/)
})
