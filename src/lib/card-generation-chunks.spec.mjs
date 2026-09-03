import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateGenerationCoverage, splitCardGenerationText } from './card-generation-chunks.mjs'

test('preserves every character while keeping chat messages together', () => {
  const text = '# 对话\n\n## 我\n第一问\n\n## GPT\n第一答\n\n## 我\n第二问\n'
  const chunks = splitCardGenerationText(text, 28)

  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.length <= 28))
})

test('splits a single oversized message without dropping text', () => {
  const text = `## 我\n${'很长的内容'.repeat(20)}`
  const chunks = splitCardGenerationText(text, 25)

  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.length <= 25))
})

test('reports exact partial and complete coverage', () => {
  const chunks = ['1234', '567', '89']

  assert.deepEqual(calculateGenerationCoverage(chunks, 2), {
    totalCharacters: 9,
    processedCharacters: 7,
    totalChunks: 3,
    processedChunks: 2,
    percentage: 78,
    complete: false,
  })
  assert.equal(calculateGenerationCoverage(chunks, 3).complete, true)
})
