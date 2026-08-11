import { BaseDirectory, exists, mkdir, open, readDir, readFile, remove, rename, SeekMode, stat, writeFile } from '@tauri-apps/plugin-fs'

import { getFilePathOptions } from '@/lib/workspace'
import emitter from '@/lib/emitter'

import {
  decryptServerBlob,
  downloadServerBlobRange,
  encryptServerBlob,
  getServerBlobMetadata,
  uploadServerBlob,
} from './note-gen-server'
import type { EncryptedServerBlob } from './note-gen-server'

export interface NoteGenServerAssetReference {
  resourceId?: string
  localPath: string
  contentHash: string
  blobId?: string
  scope?: 'appData' | 'workspace'
  size?: number
  blobKeyVersion?: number
}

export interface NoteGenServerPreparedAssetResource {
  resourceId: string
  localPath: string
  contentHash: string
  blobId: string
  scope?: 'appData' | 'workspace'
  size: number
  blobKeyVersion?: number
}

export class NoteGenServerAssetLocalConflictError extends Error {
  constructor(
    readonly localPath: string,
    readonly localContentHash: string,
    readonly remoteContentHash: string,
  ) {
    super(`本地资源与远端资源内容不同：${localPath}`)
    this.name = 'NoteGenServerAssetLocalConflictError'
  }
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
const BLOB_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const BLOB_DOWNLOAD_TEMP_DIR = 'sync-v2-downloads'
const BLOB_UPLOAD_TEMP_DIR = 'sync-v2-uploads'
const STREAMING_ASSET_THRESHOLD_BYTES = 8 * 1024 * 1024
const ENCRYPTION_CHUNK_BYTES = 4 * 1024 * 1024

export async function cleanupStaleNoteGenServerBlobDownloads(
  activeBlobIds: ReadonlySet<string>,
  olderThan: number,
): Promise<void> {
  const entries = await exists(BLOB_DOWNLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData })
    ? await readDir(BLOB_DOWNLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData }) : []
  for (const entry of entries) {
    const match = /^([A-Za-z0-9_-]{43})\.part$/.exec(entry.name)
    if (!match?.[1] || activeBlobIds.has(match[1]) || !entry.isFile) continue
    const path = `${BLOB_DOWNLOAD_TEMP_DIR}/${entry.name}`
    const info = await stat(path, { baseDir: BaseDirectory.AppData })
    const modifiedAt = info.mtime?.getTime() ?? info.birthtime?.getTime() ?? 0
    if (modifiedAt > olderThan) continue
    await remove(path, { baseDir: BaseDirectory.AppData })
  }
  if (!await exists(BLOB_UPLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData })) return
  const uploads = await readDir(BLOB_UPLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData })
  for (const entry of uploads) {
    const match = /^([0-9a-f-]{36}-v\d+-[0-9a-f-]{36}-[a-f0-9]{64})\.json$/i.exec(entry.name)
    if (!match?.[1] || !entry.isFile) continue
    const metadataPath = `${BLOB_UPLOAD_TEMP_DIR}/${entry.name}`
    let blobId: string | null = null
    try {
      const metadata = JSON.parse(new TextDecoder().decode(
        await readFile(metadataPath, { baseDir: BaseDirectory.AppData }),
      )) as { blobId?: unknown }
      blobId = typeof metadata.blobId === 'string' ? metadata.blobId : null
    } catch {
      // Invalid stale metadata is removed after the same retention window.
    }
    if (blobId && activeBlobIds.has(blobId)) continue
    const info = await stat(metadataPath, { baseDir: BaseDirectory.AppData })
    const modifiedAt = info.mtime?.getTime() ?? info.birthtime?.getTime() ?? 0
    if (modifiedAt > olderThan) continue
    await remove(metadataPath, { baseDir: BaseDirectory.AppData })
    const ciphertextPath = `${BLOB_UPLOAD_TEMP_DIR}/${match[1]}.ngb2`
    if (await exists(ciphertextPath, { baseDir: BaseDirectory.AppData })) {
      await remove(ciphertextPath, { baseDir: BaseDirectory.AppData })
    }
  }
}

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
    references.push({
      localPath,
      contentHash: await hashAssetHex(localPath, scope),
      size,
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
  expectedSyncEpoch?: string
  workspaceKey: CryptoKey
  keyVersion?: number
  resolveResourceId?: (reference: NoteGenServerAssetReference) => Promise<{
    resourceId: string
    existingBlobId?: string
  }>
  onTransferProgress?: (progress: {
    blobId: string, completedBytes: number, totalBytes: number,
  }) => void | Promise<void>
}): Promise<{
  payload: unknown
  blobRefs: string[]
  resources: NoteGenServerPreparedAssetResource[]
}> {
  const references = parseAssetReferences(input.payload)
  if (references.length === 0) return { payload: input.payload, blobRefs: [], resources: [] }
  const uploaded: NoteGenServerAssetReference[] = []
  const resources: NoteGenServerPreparedAssetResource[] = []
  for (const reference of references) {
    const scope = reference.scope ?? 'appData'
    const localPath = normalizeAssetPath(reference.localPath, scope)
    if (!await assetExists(localPath, scope)) {
      throw new Error(`待同步资源不存在：${localPath}`)
    }
    if (reference.size !== undefined && reference.size > MAX_CLIENT_BLOB_PLAINTEXT_BYTES) {
      throw new Error(`同步资源超过客户端 256 MiB 限制：${localPath}`)
    }
    const size = await assetSize(localPath, scope)
    if (await hashAssetHex(localPath, scope) !== reference.contentHash) {
      throw new Error(`待同步资源在入队后发生变化：${localPath}`)
    }
    const resolvedResource = input.resolveResourceId ? await input.resolveResourceId({
      ...reference, localPath, size,
      ...(scope === 'workspace' ? { scope } : {}),
    }) : undefined
    const resourceId = resolvedResource?.resourceId
    if (resourceId && resolvedResource.existingBlobId) {
      uploaded.push({ resourceId, localPath, contentHash: reference.contentHash,
        size, ...(scope === 'workspace' ? { scope } : {}) })
      resources.push({ resourceId, localPath, contentHash: reference.contentHash,
        size, blobId: resolvedResource.existingBlobId,
        ...(input.keyVersion ? { blobKeyVersion: input.keyVersion } : {}),
        ...(scope === 'workspace' ? { scope } : {}) })
      continue
    }
    const blob = resourceId && size >= STREAMING_ASSET_THRESHOLD_BYTES
      ? await prepareStreamingEncryptedAsset({
          workspaceId: input.workspaceId, keyVersion: input.keyVersion ?? 1,
          resourceId, localPath, scope, contentHash: reference.contentHash,
          plaintextSize: size, workspaceKey: input.workspaceKey,
        })
      : await encryptServerBlob(input.workspaceKey, await readAsset(localPath, scope))
    await uploadServerBlob({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      ...(input.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: input.expectedSyncEpoch }),
      blob,
      onProgress: input.onTransferProgress,
    })
    if (resourceId) {
      uploaded.push({ resourceId, localPath, contentHash: reference.contentHash,
        size, ...(scope === 'workspace' ? { scope } : {}) })
      resources.push({ resourceId, localPath, contentHash: reference.contentHash,
        size, blobId: blob.blobId,
        ...(input.keyVersion ? { blobKeyVersion: input.keyVersion } : {}),
        ...(scope === 'workspace' ? { scope } : {}) })
    } else {
      uploaded.push({ ...reference, localPath, size, blobId: blob.blobId,
        ...(scope === 'workspace' ? { scope } : {}) })
    }
  }
  return {
    payload: { ...(input.payload as Record<string, unknown>), assets: uploaded },
    blobRefs: input.resolveResourceId ? [] : uploaded.map(reference => reference.blobId as string),
    resources,
  }
}

export async function restoreNoteGenServerPayloadAssets(input: {
  payload: unknown
  blobRefs: string[]
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKey: CryptoKey
  preserveLocalOnConflict?: boolean
  replaceExpectedContentHash?: string
  onTransferProgress?: (progress: {
    blobId: string, completedBytes: number, totalBytes: number,
  }) => void | Promise<void>
}): Promise<void> {
  const references = parseAssetReferences(input.payload)
  const declaredBlobRefs = new Set(input.blobRefs)
  const restoredPaths: string[] = []
  for (const reference of references) {
    // v2 parents only retain resourceId. Their independent asset events own and
    // restore the Blob; legacy parent-owned Blob references remain readable.
    if (reference.resourceId && !reference.blobId) continue
    if (!reference.blobId || !declaredBlobRefs.has(reference.blobId)) {
      throw new Error(`服务器对象缺少资源引用：${reference.localPath}`)
    }
    const scope = reference.scope ?? 'appData'
    const localPath = normalizeAssetPath(reference.localPath, scope)
    if (reference.size !== undefined && reference.size > MAX_CLIENT_BLOB_PLAINTEXT_BYTES) {
      throw new Error(`远端资源超过客户端 256 MiB 限制：${localPath}`)
    }
    let existingHash: string | null = null
    if (await assetExists(localPath, scope)) {
      existingHash = await hashAssetHex(localPath, scope)
      if (existingHash === reference.contentHash) continue
      if (input.preserveLocalOnConflict && existingHash !== input.replaceExpectedContentHash) {
        throw new NoteGenServerAssetLocalConflictError(
          localPath, existingHash, reference.contentHash,
        )
      }
    }
    await ensureAssetDirectory(localPath, scope)
    const stagingPath = createAssetStagingPath(localPath, reference.blobId)
    if (await assetExists(stagingPath, scope)) await removeAsset(stagingPath, scope)
    const downloaded = await downloadServerBlobResumable({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      blobId: reference.blobId,
      onProgress: input.onTransferProgress,
    })
    try {
      if (downloaded.streaming) {
        await decryptStreamingBlobFile(
          input.workspaceKey, downloaded.path, downloaded.size,
          stagingPath, scope, reference.contentHash,
        )
      } else {
        const bytes = await decryptServerBlob(
          input.workspaceKey,
          await readFile(downloaded.path, { baseDir: BaseDirectory.AppData }),
        )
        if (await hashBytesHex(bytes) !== reference.contentHash) {
          throw new Error(`服务器资源解密后的内容校验失败：${localPath}`)
        }
        await writeAsset(stagingPath, bytes, scope)
      }
    } catch (error) {
      await removeAsset(stagingPath, scope).catch(() => undefined)
      throw error
    } finally {
      await remove(downloaded.path, { baseDir: BaseDirectory.AppData }).catch(() => undefined)
    }

    let displacedPath: string | null = null
    if (existingHash !== null) {
      displacedPath = existingHash === input.replaceExpectedContentHash
        ? createAssetReplacementBackupPath(localPath, reference.blobId)
        : createAssetConflictPath(localPath)
      if (await assetExists(displacedPath, scope)) await removeAsset(displacedPath, scope)
      await renameAsset(localPath, displacedPath, scope)
    }
    try {
      await renameAsset(stagingPath, localPath, scope)
    } catch (error) {
      if (displacedPath && await assetExists(displacedPath, scope)) {
        await renameAsset(displacedPath, localPath, scope).catch(() => undefined)
      }
      throw error
    }
    if (displacedPath?.includes('.sync-replaced-')) {
      await removeAsset(displacedPath, scope).catch(() => undefined)
    }
    if (scope === 'appData' && !localPath.startsWith('conversation-assets/')) restoredPaths.push(localPath)
  }
  if (restoredPaths.length > 0) emitter.emit('record-assets-downloaded', { paths: restoredPaths })
}

export function getNoteGenServerPayloadResourceReferences(payload: unknown): Array<{
  resourceId: string
  localPath: string
}> {
  return parseAssetReferences(payload).flatMap(reference => reference.resourceId
    ? [{
        resourceId: reference.resourceId,
        localPath: normalizeAssetPath(reference.localPath, reference.scope ?? 'appData'),
      }]
    : [])
}

async function downloadServerBlobResumable(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  blobId: string
  onProgress?: (progress: {
    blobId: string, completedBytes: number, totalBytes: number,
  }) => void | Promise<void>
}): Promise<{ path: string, size: number, streaming: boolean }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.blobId)) throw new Error('Blob ID 格式无效')
  const metadata = await getServerBlobMetadata(input)
  await mkdir(BLOB_DOWNLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  const temporaryPath = `${BLOB_DOWNLOAD_TEMP_DIR}/${input.blobId}.part`
  let completedBytes = await exists(temporaryPath, { baseDir: BaseDirectory.AppData })
    ? (await stat(temporaryPath, { baseDir: BaseDirectory.AppData })).size
    : 0
  if (completedBytes > metadata.size) {
    await remove(temporaryPath, { baseDir: BaseDirectory.AppData })
    completedBytes = 0
  }
  await input.onProgress?.({ blobId: input.blobId, completedBytes, totalBytes: metadata.size })

  if (completedBytes < metadata.size) {
    const handle = await open(temporaryPath, {
      baseDir: BaseDirectory.AppData, append: true, create: true,
    })
    try {
      while (completedBytes < metadata.size) {
        const end = Math.min(metadata.size - 1, completedBytes + BLOB_DOWNLOAD_CHUNK_BYTES - 1)
        const chunk = await downloadServerBlobRange({ ...input, start: completedBytes, end })
        await writeAll(handle, chunk)
        completedBytes += chunk.byteLength
        await input.onProgress?.({
          blobId: input.blobId, completedBytes, totalBytes: metadata.size,
        })
      }
    } finally {
      await handle.close()
    }
  }

  try {
    if (await hashAppDataFileBase64Url(temporaryPath) !== input.blobId) {
      throw new Error('服务器 Blob 完整性校验失败')
    }
    const handle = await open(temporaryPath, { baseDir: BaseDirectory.AppData, read: true })
    let magic: Uint8Array
    try {
      magic = await readExactly(handle, 4)
    } finally {
      await handle.close()
    }
    return {
      path: temporaryPath,
      size: metadata.size,
      streaming: magic[0] === 0x4e && magic[1] === 0x47
        && magic[2] === 0x42 && magic[3] === 0x32,
    }
  } catch (error) {
    await remove(temporaryPath, { baseDir: BaseDirectory.AppData }).catch(() => undefined)
    throw error
  }
}

async function hashAppDataFileBase64Url(path: string): Promise<string> {
  const hasher = await import('hash-wasm').then(module => module.createSHA256())
  hasher.init()
  const handle = await open(path, { baseDir: BaseDirectory.AppData, read: true })
  try {
    const buffer = new Uint8Array(BLOB_DOWNLOAD_CHUNK_BYTES)
    while (true) {
      const read = await handle.read(buffer)
      if (read === null || read === 0) break
      hasher.update(buffer.subarray(0, read))
    }
  } finally {
    await handle.close()
  }
  return hexToBase64Url(String(hasher.digest('hex')))
}

async function decryptStreamingBlobFile(
  workspaceKey: CryptoKey,
  path: string,
  ciphertextSize: number,
  targetPath: string,
  targetScope: 'appData' | 'workspace',
  expectedContentHash: string,
): Promise<void> {
  const sourceHandle = await open(path, { baseDir: BaseDirectory.AppData, read: true })
  const target = await resolveAssetPath(targetPath, targetScope)
  const targetHandle = await open(target.path, {
    write: true, create: true, truncate: true,
    ...(target.baseDir ? { baseDir: target.baseDir } : {}),
  })
  const plaintextHasher = await import('hash-wasm').then(module => module.createSHA256())
  plaintextHasher.init()
  try {
    const header = await readExactly(sourceHandle, 24)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const chunkBytes = view.getUint32(4)
    const plaintextSize = Number(view.getBigUint64(8))
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0
      || plaintextSize > MAX_CLIENT_BLOB_PLAINTEXT_BYTES
      || chunkBytes < 64 * 1024 || chunkBytes > 16 * 1024 * 1024) {
      throw new Error('服务器 Blob 分块加密头无效')
    }
    const chunkCount = Math.ceil(plaintextSize / chunkBytes)
    if (24 + plaintextSize + (chunkCount * 16) !== ciphertextSize) {
      throw new Error('服务器 Blob 分块密文长度无效')
    }
    let plaintextOffset = 0
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const plainLength = Math.min(chunkBytes, plaintextSize - plaintextOffset)
      const encrypted = await readExactly(sourceHandle, plainLength + 16)
      const nonce = new Uint8Array(12)
      nonce.set(header.subarray(16, 24), 0)
      new DataView(nonce.buffer).setUint32(8, chunkIndex)
      const chunkNumber = new Uint8Array(4)
      new DataView(chunkNumber.buffer).setUint32(0, chunkIndex)
      const additionalData = concatBytes(
        new TextEncoder().encode('notegen-server-blob-v2'), header, chunkNumber,
      )
      const decrypted = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData }, workspaceKey, encrypted,
      ))
      await writeAll(targetHandle, decrypted)
      plaintextHasher.update(decrypted)
      plaintextOffset += decrypted.byteLength
    }
    if (String(plaintextHasher.digest('hex')) !== expectedContentHash) {
      throw new Error(`服务器资源解密后的内容校验失败：${targetPath}`)
    }
  } finally {
    await Promise.all([sourceHandle.close(), targetHandle.close()])
  }
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
  if (assets.length > 1_000) throw new Error('单个同步对象不能引用超过 1000 个资源')
  return assets.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('同步对象包含无效的资源引用')
    }
    const reference = item as Record<string, unknown>
    if (typeof reference.localPath !== 'string' || typeof reference.contentHash !== 'string'
      || (reference.resourceId !== undefined && typeof reference.resourceId !== 'string')
      || (reference.blobId !== undefined && typeof reference.blobId !== 'string')
      || (reference.size !== undefined && (
        typeof reference.size !== 'number' || !Number.isSafeInteger(reference.size) || reference.size < 0
      ))
      || (reference.scope !== undefined && reference.scope !== 'appData' && reference.scope !== 'workspace')) {
      throw new Error('同步对象包含无效的资源引用')
    }
    if (!/^[a-f0-9]{64}$/.test(reference.contentHash)
      || (typeof reference.resourceId === 'string'
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.resourceId))
      || (typeof reference.blobId === 'string' && !/^[A-Za-z0-9_-]{43}$/.test(reference.blobId))) {
      throw new Error('同步对象包含校验值无效的资源引用')
    }
    return {
      localPath: reference.localPath,
      contentHash: reference.contentHash,
      ...(reference.resourceId ? { resourceId: reference.resourceId } : {}),
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

async function removeAsset(
  localPath: string,
  scope: 'appData' | 'workspace',
): Promise<void> {
  const resolved = await resolveAssetPath(localPath, scope)
  await remove(resolved.path, resolved.baseDir ? { baseDir: resolved.baseDir } : undefined)
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
  const parts = localPath.split('/')
  const filename = parts.pop() as string
  return [...parts, `.${filename}.sync-conflict-${suffix}-${crypto.randomUUID()}`].join('/')
}

function createAssetStagingPath(localPath: string, blobId: string): string {
  const parts = localPath.split('/')
  const filename = parts.pop() as string
  return [...parts, `.${filename}.sync-download-${blobId.slice(0, 12)}`].join('/')
}

function createAssetReplacementBackupPath(localPath: string, blobId: string): string {
  const parts = localPath.split('/')
  const filename = parts.pop() as string
  return [...parts, `.${filename}.sync-replaced-${blobId.slice(0, 12)}-${crypto.randomUUID()}`].join('/')
}

async function hashBytesHex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashAssetHex(
  localPath: string,
  scope: 'appData' | 'workspace',
): Promise<string> {
  const hasher = await import('hash-wasm').then(module => module.createSHA256())
  hasher.init()
  const resolved = await resolveAssetPath(localPath, scope)
  const handle = await open(resolved.path, {
    read: true,
    ...(resolved.baseDir ? { baseDir: resolved.baseDir } : {}),
  })
  try {
    const buffer = new Uint8Array(ENCRYPTION_CHUNK_BYTES)
    while (true) {
      const read = await handle.read(buffer)
      if (read === null || read === 0) break
      hasher.update(buffer.subarray(0, read))
    }
  } finally {
    await handle.close()
  }
  return String(hasher.digest('hex'))
}

async function prepareStreamingEncryptedAsset(input: {
  workspaceId: string
  keyVersion: number
  resourceId: string
  localPath: string
  scope: 'appData' | 'workspace'
  contentHash: string
  plaintextSize: number
  workspaceKey: CryptoKey
}): Promise<EncryptedServerBlob> {
  await mkdir(BLOB_UPLOAD_TEMP_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  const basename = `${input.workspaceId}-v${input.keyVersion}-${input.resourceId}-${input.contentHash}`
  const ciphertextPath = `${BLOB_UPLOAD_TEMP_DIR}/${basename}.ngb2`
  const metadataPath = `${BLOB_UPLOAD_TEMP_DIR}/${basename}.json`
  const expectedSize = 24 + input.plaintextSize
    + (Math.ceil(input.plaintextSize / ENCRYPTION_CHUNK_BYTES) * 16)
  if (await exists(ciphertextPath, { baseDir: BaseDirectory.AppData })
    && await exists(metadataPath, { baseDir: BaseDirectory.AppData })
    && (await stat(ciphertextPath, { baseDir: BaseDirectory.AppData })).size === expectedSize) {
    try {
      const metadata = JSON.parse(new TextDecoder().decode(
        await readFile(metadataPath, { baseDir: BaseDirectory.AppData }),
      )) as { blobId?: unknown, ciphertextHash?: unknown, ciphertextSize?: unknown }
      if (typeof metadata.blobId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(metadata.blobId)
        && metadata.ciphertextHash === metadata.blobId && metadata.ciphertextSize === expectedSize) {
        return encryptedBlobFileSource(ciphertextPath, metadata.blobId, expectedSize)
      }
    } catch {
      // Incomplete or corrupt metadata is replaced together with the ciphertext.
    }
  }

  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', input.workspaceKey))
  const hmacKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const plaintextHash = hexToBytes(input.contentHash)
  const nonceMaterial = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, plaintextHash))
  const header = new Uint8Array(24)
  header.set([0x4e, 0x47, 0x42, 0x32], 0)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(4, ENCRYPTION_CHUNK_BYTES)
  headerView.setBigUint64(8, BigInt(input.plaintextSize))
  header.set(nonceMaterial.subarray(0, 8), 16)

  const source = await resolveAssetPath(input.localPath, input.scope)
  const sourceHandle = await open(source.path, {
    read: true, ...(source.baseDir ? { baseDir: source.baseDir } : {}),
  })
  const targetHandle = await open(ciphertextPath, {
    baseDir: BaseDirectory.AppData, write: true, create: true, truncate: true,
  })
  const ciphertextHasher = await import('hash-wasm').then(module => module.createSHA256())
  ciphertextHasher.init()
  try {
    await writeAll(targetHandle, header)
    ciphertextHasher.update(header)
    let remaining = input.plaintextSize
    let chunkIndex = 0
    while (remaining > 0) {
      const plaintext = await readExactly(sourceHandle, Math.min(ENCRYPTION_CHUNK_BYTES, remaining))
      const nonce = new Uint8Array(12)
      nonce.set(header.subarray(16, 24), 0)
      new DataView(nonce.buffer).setUint32(8, chunkIndex)
      const chunkNumber = new Uint8Array(4)
      new DataView(chunkNumber.buffer).setUint32(0, chunkIndex)
      const additionalData = concatBytes(
        new TextEncoder().encode('notegen-server-blob-v2'), header, chunkNumber,
      )
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData }, input.workspaceKey, plaintext,
      ))
      await writeAll(targetHandle, encrypted)
      ciphertextHasher.update(encrypted)
      remaining -= plaintext.byteLength
      chunkIndex += 1
    }
    const extra = new Uint8Array(1)
    if (await sourceHandle.read(extra) !== null) throw new Error('附件加密期间文件长度发生变化')
  } catch (error) {
    await remove(ciphertextPath, { baseDir: BaseDirectory.AppData }).catch(() => undefined)
    throw error
  } finally {
    await Promise.all([sourceHandle.close(), targetHandle.close()])
  }
  const blobId = hexToBase64Url(String(ciphertextHasher.digest('hex')))
  await writeFile(metadataPath, new TextEncoder().encode(JSON.stringify({
    blobId, ciphertextHash: blobId, ciphertextSize: expectedSize,
  })), { baseDir: BaseDirectory.AppData })
  return encryptedBlobFileSource(ciphertextPath, blobId, expectedSize)
}

function encryptedBlobFileSource(
  ciphertextPath: string,
  blobId: string,
  ciphertextSize: number,
): EncryptedServerBlob {
  return {
    blobId,
    ciphertextHash: blobId,
    ciphertextSize,
    readRange: async (start, endExclusive) => {
      const handle = await open(ciphertextPath, { baseDir: BaseDirectory.AppData, read: true })
      try {
        await handle.seek(start, SeekMode.Start)
        return await readExactly(handle, endExclusive - start)
      } finally {
        await handle.close()
      }
    },
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
): Promise<Uint8Array> {
  const result = new Uint8Array(length)
  let offset = 0
  while (offset < length) {
    const read = await handle.read(result.subarray(offset))
    if (read === null || read === 0) throw new Error('读取附件分片时提前到达文件结尾')
    offset += read
  }
  return result
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes.subarray(offset))
    if (written <= 0) throw new Error('写入附件密文分片失败')
    offset += written
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, (index * 2) + 2), 16)
  }
  return result
}

function hexToBase64Url(value: string): string {
  let binary = ''
  for (const byte of hexToBytes(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
