import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { materializeMerge, mergeMarkdownThreeWay } from './markdown-three-way-merge'

describe('Markdown three-way merge', () => {
  it('automatically combines non-overlapping edits', () => {
    const parts = mergeMarkdownThreeWay('title\nbody\nend\n', 'new title\nbody\nend\n', 'title\nbody\nnew end\n')
    assert.equal(parts.some(part => part.type === 'conflict'), false)
    assert.equal(materializeMerge(parts, {}), 'new title\nbody\nnew end\n')
  })

  it('preserves both versions for an overlapping edit', () => {
    const parts = mergeMarkdownThreeWay('same\n', 'local\n', 'remote\n')
    const conflict = parts.find(part => part.type === 'conflict')
    assert.ok(conflict?.type === 'conflict')
    assert.equal(conflict.block.base, 'same\n')
    assert.equal(conflict.block.local, 'local\n')
    assert.equal(conflict.block.remote, 'remote\n')
  })

  it('accepts a manual per-block resolution', () => {
    const parts = mergeMarkdownThreeWay('same\n', 'local\n', 'remote\n')
    const conflict = parts.find(part => part.type === 'conflict')
    assert.ok(conflict?.type === 'conflict')
    assert.equal(materializeMerge(parts, { [conflict.block.id]: 'manual\n' }), 'manual\n')
  })
})
