import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSafeWorkspaceRelativePathInput,
  normalizeOptionalWorkspaceFolderInput,
} from '../workspace-path-safety'

test('workspace path guard rejects absolute, UNC, drive-relative, and traversal inputs', () => {
  const invalid = [
    'C:\\Users\\example\\outside.md',
    'C:/Users/example/outside.md',
    'C:outside.md',
    '\\\\server\\share\\outside.md',
    '//server/share/outside.md',
    '/etc/passwd',
    '../outside.md',
    'notes/../outside.md',
    'notes/./inside.md',
  ]
  for (const candidate of invalid) {
    assert.throws(() => assertSafeWorkspaceRelativePathInput(candidate), Error, candidate)
  }
})

test('workspace path guard accepts normalized workspace-relative targets', () => {
  for (const candidate of ['note.md', 'notes/note.md', '中文/笔记.md']) {
    assert.doesNotThrow(() => assertSafeWorkspaceRelativePathInput(candidate), candidate)
  }
})

test('optional destination folder treats an empty string as the workspace root', () => {
  assert.equal(normalizeOptionalWorkspaceFolderInput(''), '')
  assert.equal(normalizeOptionalWorkspaceFolderInput('   '), '')
  assert.equal(normalizeOptionalWorkspaceFolderInput('archive/2026'), 'archive/2026')
  assert.throws(() => normalizeOptionalWorkspaceFolderInput('../outside'))
})
