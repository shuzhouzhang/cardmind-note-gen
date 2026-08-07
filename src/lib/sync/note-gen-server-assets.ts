import { BaseDirectory, exists, mkdir, readFile, rename, stat, writeFile } from '@tauri-apps/plugin-fs'

import { getFilePathOptions } from '@/lib/workspace'
import emitter from '@/lib/emitter'

import {
  downloadServerBlob,
  encryptServerBlob,
  uploadServerBlob,
} from './note-gen-server'

export interface NoteGenServerAssetReference {
  localPath: string
  contentHash: string
  blobId?: string
  scope?: 'appData' | 'workspace'
  size?: number
}

const ALLOWED_ASSET_DIRECTORIES = [
  'screenshot/',
  'image/',
  'recordings/',
  'link-assets/',
  'record-files/',
  'conversation-assets/',
]
const MAX_CLIENT_BLOB_PLAINTEXT_BYTES = 256 * 1024 * 1024

export async function collectNoteGenServerAssetReferences(
  paths: string[],
  scope: 'appData' | 'workspace' = 'appData',
): Promise<NoteGenServerAssetReference[]> {
  const references: NoteGenServerAssetReference[] = []
  for (const candidate of Array.from(new Set(paths))) {
    const localPath = normalizeAssetPath(candidate, scope)
    if (!await assetExists(localPath, scope)) continue
    const size = await assetSize(localPath, scope)
    if (size > MAX_CLIENT_BLOB_PLAINTEXT_BYTES) {
      references.push({
        localPath,
        contentHash: '0'.repeat(64),
        size,
        ...(scope === 'workspace' ? { scope } : {}),
      })
      continue
    }
    const bytes = await readAsset(localPath, scope)
    references.push({
      localPath,
      contentHash: await hashBytesHex(bytes),
      size: bytes.byteLength,
      ...(scope === 'workspace' ? { scope } : {}),
    })
  }
  return references
}

export async function prepareNoteGenServerPayloadAssets(input: {
  payload: unknown
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKey: CryptoKey
}): Promise<{ payload: unknown, blobRefs: string[] }> {
  const references = parseAssetReferences(input.payload)
  if (references.length === 0) return { payload: input.payload, blobRefs: [] }
  const uploaded: NoteGenServerAssetReference[] = []
  for (const reference of references) {
    const scope = reference.scope ?? 'appData'
    const localPath = normalizeAssetPath(reference.localPath, scope)
    if (!await assetExists(localPath, scope)) {
      throw new Error(`待同步资源不存在：${localPath}`)
    }
    if (reference.size !== undefined && reference.size > MAX_CLIENT_BLOB_PLAINTEXT_BYTES) {
      throw new Error(`同步资源超过客户端 256 MiB 限制：${localPath}`)
    }
    const bytes = await readAsset(localPath, scope)
    if (await hashBytesHex(bytes) !== reference.contentHash) {
      throw new Error(`待同步资源在入队后发生变化：${localPath}`)
    }
    const blob = await encryptServerBlob(input.workspaceKey, bytes)
    await uploadServerBlob({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      blob,
    })
    uploaded.push({ ...reference, localPath, size: bytes.byteLength, blobId: blob.blobId, ...(scope === 'workspace' ? { scope } : {}) })
  }
  return {
    payload: { ...(input.payload as Record<string, unknown>), assets: uploaded },
    blobRefs: uploaded.map(reference => reference.blobId as string),
  }
}

export async function restoreNoteGenServerPayloadAssets(input: {
  payload: unknown
  blobRefs: string[]
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKey: CryptoKey
}): Promise<void> {
  const references = parseAssetReferences(input.payload)
  const declaredBlobRefs = new Set(input.blobRefs)
  const restoredPaths: string[] = []
  for (const reference of references) {
    if (!reference.blobId || !declaredBlobRefs.has(reference.blobId)) {
      throw new Error(`服务器对象缺少资源引用：${reference.localPath}`)
    }
    const scope = reference.scope ?? 'appData'
    const localPath = normalizeAssetPath(reference.localPath, scope)
    if (reference.size !== undefined && reference.size > MAX_CLIENT_BLOB_PLAINTEXT_BYTES) {
      throw new Error(`远端资源超过客户端 256 MiB 限制：${localPath}`)
    }
    if (await assetExists(localPath, scope)) {
      const existing = await readAsset(localPath, scope)
      if (await hashBytesHex(existing) === reference.contentHash) continue
      await renameAsset(localPath, createAssetConflictPath(localPath), scope)
    }
    const bytes = await downloadServerBlob({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      blobId: reference.blobId,
      workspaceKey: input.workspaceKey,
    })
    if (await hashBytesHex(bytes) !== reference.contentHash) {
      throw new Error(`服务器资源解密后的内容校验失败：${localPath}`)
    }
    await ensureAssetDirectory(localPath, scope)
    await writeAsset(localPath, bytes, scope)
    if (scope === 'appData' && !localPath.startsWith('conversation-assets/')) restoredPaths.push(localPath)
  }
  if (restoredPaths.length > 0) emitter.emit('record-assets-downloaded', { paths: restoredPaths })
}

export function stripNoteGenServerAssetTransportFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNoteGenServerAssetTransportFields)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'value' && (source.type === 'tag' || source.type === 'mark')
      && item && typeof item === 'object' && !Array.isArray(item)) {
      const payloadValue = { ...(item as Record<string, unknown>) }
      Reflect.deleteProperty(payloadValue, 'legacyId')
      result[key] = stripNoteGenServerAssetTransportFields(payloadValue)
      continue
    }
    if (key === 'assets' && Array.isArray(item)) {
      result[key] = item.map(asset => {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
        const reference = { ...(asset as Record<string, unknown>) }
        Reflect.deleteProperty(reference, 'blobId')
        return reference
      })
      continue
    }
    result[key] = stripNoteGenServerAssetTransportFields(item)
  }
  return result
}

function parseAssetReferences(payload: unknown): NoteGenServerAssetReference[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const assets = (payload as Record<string, unknown>).assets
  if (assets === undefined) return []
  if (!Array.isArray(assets)) throw new Error('同步对象包含无效的资源引用')
  return assets.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('同步对象包含无效的资源引用')
    }
    const reference = item as Record<string, unknown>
    if (typeof reference.localPath !== 'string' || typeof reference.contentHash !== 'string'
      || (reference.blobId !== undefined && typeof reference.blobId !== 'string')
      || (reference.size !== undefined && (
        typeof reference.size !== 'number' || !Number.isSafeInteger(reference.size) || reference.size < 0
      ))
      || (reference.scope !== undefined && reference.scope !== 'appData' && reference.scope !== 'workspace')) {
      throw new Error('同步对象包含无效的资源引用')
    }
    if (!/^[a-f0-9]{64}$/.test(reference.contentHash)
      || (typeof reference.blobId === 'string' && !/^[A-Za-z0-9_-]{43}$/.test(reference.blobId))) {
      throw new Error('同步对象包含校验值无效的资源引用')
    }
    return {
      localPath: reference.localPath,
      contentHash: reference.contentHash,
      ...(typeof reference.size === 'number' ? { size: Number(reference.size) } : {}),
      ...(reference.blobId ? { blobId: reference.blobId } : {}),
      ...(reference.scope === 'workspace' ? { scope: 'workspace' as const } : {}),
    }
  })
}

function normalizeAssetPath(value: string, scope: 'appData' | 'workspace'): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(segment => segment === '..')
    || (scope === 'appData' && !ALLOWED_ASSET_DIRECTORIES.some(directory => normalized.startsWith(directory)))) {
    throw new Error(`同步资源路径不安全：${value}`)
  }
  return normalized
}

async function ensureAssetDirectory(localPath: string, scope: 'appData' | 'workspace'): Promise<void> {
  const directory = localPath.split('/').slice(0, -1).join('/')
  if (!directory) return
  const resolved = await resolveAssetPath(directory, scope)
  if (!await exists(resolved.path, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)) {
    await mkdir(resolved.path, { ...(resolved.baseDir ? { baseDir: resolved.baseDir } : {}), recursive: true })
  }
}

async function resolveAssetPath(localPath: string, scope: 'appData' | 'workspace') {
  if (scope === 'workspace') return await getFilePathOptions(localPath)
  return { path: localPath, baseDir: BaseDirectory.AppData }
}

async function assetExists(localPath: string, scope: 'appData' | 'workspace'): Promise<boolean> {
  const resolved = await resolveAssetPath(localPath, scope)
  return await exists(resolved.path, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)
}

async function readAsset(localPath: string, scope: 'appData' | 'workspace'): Promise<Uint8Array> {
  const resolved = await resolveAssetPath(localPath, scope)
  return await readFile(resolved.path, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)
}

async function assetSize(localPath: string, scope: 'appData' | 'workspace'): Promise<number> {
  const resolved = await resolveAssetPath(localPath, scope)
  return (await stat(resolved.path, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)).size
}

async function writeAsset(
  localPath: string,
  bytes: Uint8Array,
  scope: 'appData' | 'workspace',
): Promise<void> {
  const resolved = await resolveAssetPath(localPath, scope)
  await writeFile(resolved.path, bytes, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)
}

async function renameAsset(
  oldPath: string,
  newPath: string,
  scope: 'appData' | 'workspace',
): Promise<void> {
  const [oldResolved, newResolved] = await Promise.all([
    resolveAssetPath(oldPath, scope),
    resolveAssetPath(newPath, scope),
  ])
  await rename(oldResolved.path, newResolved.path, oldResolved.baseDir || newResolved.baseDir ? {
    ...(oldResolved.baseDir ? { oldPathBaseDir: oldResolved.baseDir } : {}),
    ...(newResolved.baseDir ? { newPathBaseDir: newResolved.baseDir } : {}),
  } : undefined)
}

function createAssetConflictPath(localPath: string): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  return `${localPath}.sync-conflict-${suffix}`
}

async function hashBytesHex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
