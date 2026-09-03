import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { toTextDiffSegments } from './diff-viewer-security.mjs'

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diff-viewer.tsx')

const hostileMarkup = [
  '<img src="https://attacker.invalid/pixel">',
  '<svg><script>alert(1)</script></svg>',
  '<style>body{display:none}</style>',
  '<a href="https://attacker.invalid">fake approval</a>',
  '<script>alert(document.cookie)</script>',
]

test('diff segments preserve hostile markup only as inert text', () => {
  const segments = toTextDiffSegments(hostileMarkup.map((value) => ({ value, added: true })))

  assert.deepEqual(segments.map((segment) => segment.text), hostileMarkup)
  for (const segment of segments) {
    const rendered = renderToStaticMarkup(React.createElement('span', null, segment.text))
    assert.doesNotMatch(rendered, /<(?:img|svg|style|a|script)\b/i)
    assert.match(rendered, /&lt;/)
  }
})

test('DiffViewer renders line and word content as React text children', () => {
  const source = readFileSync(sourcePath, 'utf8')

  assert.doesNotMatch(source, /dangerouslySetInnerHTML|__html|\.innerHTML\b/)
  assert.match(source, /\{line\.content\}/)
  assert.match(source, /\{segment\.text\}/)
})
