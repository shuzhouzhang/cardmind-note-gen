import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const scanner = resolve(dirname(fileURLToPath(import.meta.url)), 'secret-scan.mjs')

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
}

function scan(cwd) {
  return spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8', windowsHide: true })
}

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), 'cardmind-secret-scan-'))
  git(root, 'init', '--quiet')
  return root
}

test('secret scanner passes clean text and harmless NUL-containing binaries', () => {
  const root = fixtureRepository()
  try {
    writeFileSync(join(root, 'safe.txt'), 'no credentials here\n')
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    git(root, 'add', '--all')
    const result = scan(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /secret-scan: passed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret scanner rejects store, database, and dependency-cache paths even when binary', () => {
  const root = fixtureRepository()
  try {
    writeFileSync(join(root, 'store.json'), '{}\n')
    writeFileSync(join(root, 'notes.db'), Buffer.from([0, 1, 2, 3]))
    mkdirSync(join(root, 'cache'))
    writeFileSync(join(root, 'cache', 'artifact.bin'), Buffer.from([0, 1]))
    git(root, 'add', '--force', '--all')
    const result = scan(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /store-file: store\.json/)
    assert.match(result.stderr, /database-file: notes\.db/)
    assert.match(result.stderr, /dependency-cache: cache[\\/]artifact\.bin/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret scanner catches generic quoted credentials without printing values', () => {
  const root = fixtureRepository()
  const keyName = ['api', 'Key'].join('')
  const value = ['opaque', 'fixture', 'value'].join('-')
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ [keyName]: value }))
    git(root, 'add', '--all')
    const result = scan(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /credential-literal: config\.json/)
    assert.doesNotMatch(result.stderr, new RegExp(value))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret scanner fails closed while printing only rule and path', () => {
  const root = fixtureRepository()
  const token = ['sk', 'fixture', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----', '\nfixture\n', '-----END ', 'PRIVATE KEY-----'].join('')
  try {
    writeFileSync(join(root, 'credential.txt'), `${token}\n${privateKey}\n`)
    git(root, 'add', '--all')
    const result = scan(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /openai-style-token: credential\.txt/)
    assert.match(result.stderr, /private-key: credential\.txt/)
    assert.doesNotMatch(result.stderr, new RegExp(token))
    assert.doesNotMatch(result.stderr, /fixture\n-----END/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret scanner returns configuration exit 2 outside a Git repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'cardmind-secret-scan-no-git-'))
  try {
    const result = scan(root)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /unable to enumerate repository files/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
