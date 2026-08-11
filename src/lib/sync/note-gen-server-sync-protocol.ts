import { normalizeServerOrigin, serverRequest } from './note-gen-server'

export type SyncV2ObjectKind =
  | 'note' | 'folder' | 'asset' | 'canvas' | 'record' | 'tag' | 'mark'
  | 'conversation' | 'memory' | 'setting' | 'yjs-checkpoint' | 'yjs-update'

export interface SyncV2Event {
  eventId: string
  sequence: string
  commandId: string
  sourceDeviceId: string
  type: string
  objectId: string | null
  documentId: string | null
  documentSequence: string | null
  keyVersion: number | null
  ciphertext: string | null
  ciphertextHash: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type SyncV2Command = Record<string, unknown> & {
  commandId: string
  type: string
  objectId?: string
  documentId?: string
}

export interface SyncV2CommandResult {
  commandId: string
  status: 'applied' | 'conflict' | 'rejected'
  duplicate: boolean
  sequence?: string
  revision?: string
  documentSequence?: string
  conflictId?: string
  code?: string
  retryable?: boolean
  details?: Record<string, unknown>
}

export interface SyncV2HistoricalObjectVersion {
  workspaceId: string
  objectId: string
  revision: string
  sequence: string
  kind: SyncV2ObjectKind
  parentObjectId: string | null
  nameCiphertext: string | null
  nameBlindIndex: string | null
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefs: string[]
  deleted: boolean
  createdAt: string
  currentRevision?: string | null
}

export interface SyncV2Aad {
  workspaceId: string
  objectId: string
  kind: string
  keyVersion: number
  purpose: 'object' | 'update' | 'checkpoint' | 'conflict'
  identity: string
}

export async function getSyncV2ObjectVersion(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  objectId: string
  revision: string
  expectedSyncEpoch?: string
}): Promise<{
  object: SyncV2HistoricalObjectVersion
  resources: SyncV2HistoricalObjectVersion[]
}> {
  const query = new URLSearchParams()
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  const queryString = query.toString()
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/objects/${input.objectId}/versions/${input.revision}${queryString ? `?${queryString}` : ''}`,
    { accessToken: input.accessToken },
  )
}

export async function listSyncV2ObjectVersions(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  objectId: string
  before?: string | null
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{
  versions: SyncV2HistoricalObjectVersion[]
  nextBefore: string | null
  hasMore: boolean
}> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 20) })
  if (input.before) query.set('before', input.before)
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/objects/${input.objectId}/versions?${query.toString()}`,
    { accessToken: input.accessToken },
  )
}

export async function pushSyncV2Commands(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  expectedSyncEpoch?: string
  commands: SyncV2Command[]
}): Promise<SyncV2CommandResult[]> {
  const response = await serverRequest<{ results: SyncV2CommandResult[] }>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/commands`,
    { method: 'POST', accessToken: input.accessToken, body: {
      commands: input.commands,
      ...(input.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: input.expectedSyncEpoch }),
    } },
  )
  return response.results
}

export async function pullSyncV2Events(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  after: string
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{ events: SyncV2Event[], nextCursor: string, latestSequence: string, hasMore: boolean }> {
  const query = new URLSearchParams({ after: input.after, limit: String(input.limit ?? 200) })
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/events?${query}`,
    { accessToken: input.accessToken },
  )
}

export interface SyncV2BootstrapObject {
  objectId: string
  kind: SyncV2ObjectKind
  parentObjectId: string | null
  nameCiphertext: string | null
  nameBlindIndexPresent: boolean
  currentRevision: string
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefs: string[]
  deletedAt: string | null
  document: null | {
    documentId: string
    latestDocumentSequence: string
    checkpointDocumentSequence: string
    checkpointId: string | null
    checkpointKeyVersion: number | null
    checkpointCiphertext: string | null
    checkpointCiphertextHash: string | null
  }
}

export interface SyncV2BootstrapConflict {
  conflictId: string
  objectId: string
  kind: SyncV2ObjectKind
  type: string
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  createdSequence: string
}

export async function bootstrapSyncV2(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  bootstrapId?: string
  afterObjectId?: string
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{
  bootstrapId: string
  snapshotSequence: string
  objects: SyncV2BootstrapObject[]
  conflicts: SyncV2BootstrapConflict[]
  nextObjectId: string | null
  hasMore: boolean
}> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 200) })
  if (input.bootstrapId) query.set('bootstrapId', input.bootstrapId)
  if (input.afterObjectId) query.set('afterObjectId', input.afterObjectId)
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/bootstrap?${query}`,
    { accessToken: input.accessToken },
  )
}

export async function pullSyncV2DocumentUpdates(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  documentId: string
  after: string
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{
  updates: Array<{
    documentSequence: string
    updateId: string
    keyVersion: number
    ciphertext: string
    ciphertextHash: string
  }>
  nextDocumentSequence: string
  hasMore: boolean
}> {
  const query = new URLSearchParams({ after: input.after, limit: String(input.limit ?? 500) })
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/documents/${encodeURIComponent(input.documentId)}/updates?${query}`,
    { accessToken: input.accessToken },
  )
}

export async function encryptSyncV2Payload(
  key: CryptoKey,
  payload: unknown | Uint8Array,
  aad: SyncV2Aad,
): Promise<{ ciphertext: string, ciphertextHash: string }> {
  const plaintext = payload instanceof Uint8Array
    ? payload
    : new TextEncoder().encode(JSON.stringify(payload))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encodeAad(aad) },
    key,
    plaintext,
  ))
  const envelope = new Uint8Array(2 + nonce.length + encrypted.length)
  envelope.set([0x02, 0x01])
  envelope.set(nonce, 2)
  envelope.set(encrypted, 14)
  return {
    ciphertext: toBase64Url(envelope),
    ciphertextHash: await sha256Base64Url(envelope),
  }
}

export async function decryptSyncV2Payload<T = unknown>(
  key: CryptoKey,
  ciphertext: string,
  aad: SyncV2Aad,
  binary = false,
  allowLegacyObjectEnvelope = false,
): Promise<T> {
  const envelope = fromBase64Url(ciphertext)
  if (envelope.length <= 30 || envelope[0] !== 0x02 || envelope[1] !== 0x01) {
    if (!allowLegacyObjectEnvelope || aad.purpose !== 'object') {
      throw new Error('不支持的同步加密 envelope')
    }
    const legacyPlaintext = await decryptLegacyObjectEnvelope(key, envelope)
    if (binary) return legacyPlaintext as T
    const legacyPayload = hasBytePrefix(legacyPlaintext, [0x4e, 0x47, 0x5a, 0x31])
      ? await decompressLegacyObject(legacyPlaintext.slice(4))
      : legacyPlaintext
    return JSON.parse(new TextDecoder().decode(legacyPayload)) as T
  }
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: envelope.slice(2, 14), additionalData: encodeAad(aad) },
    key,
    envelope.slice(14),
  ))
  return (binary ? plaintext : JSON.parse(new TextDecoder().decode(plaintext))) as T
}

async function decryptLegacyObjectEnvelope(key: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
  if (envelope.length <= 28) throw new Error('旧版同步加密 envelope 无效')
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: envelope.slice(0, 12) },
    key,
    envelope.slice(12),
  ))
}

async function decompressLegacyObject(value: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前系统不支持解压旧版同步对象')
  const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function hasBytePrefix(value: Uint8Array, prefix: readonly number[]): boolean {
  return value.length >= prefix.length && prefix.every((byte, index) => value[index] === byte)
}

/**
 * Produces a keyed equality index without exposing the file name to the server.
 * Parent identity is part of the input, so equal names in different folders do
 * not correlate. The index intentionally leaks equality within one directory;
 * that is the minimum information required for server-side collision detection.
 */
export async function createSyncV2NameBlindIndex(input: {
  key: CryptoKey
  workspaceId: string
  parentObjectId: string | null
  name: string
}): Promise<string> {
  const rawKey = await crypto.subtle.exportKey('raw', input.key)
  const hmacKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const normalizedName = input.name.normalize('NFC').trim().toLowerCase()
  const message = new TextEncoder().encode(JSON.stringify([
    'notegen-sync-v1-name', input.workspaceId, input.parentObjectId ?? '__root__', normalizedName,
  ]))
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message)))
}

/** Name indexes must survive content-key rotation, so v2 anchors them to the
 * oldest retained workspace key instead of whichever key encrypts this command. */
export function getSyncV2StableBlindIndexKey(
  keys: ReadonlyMap<number, CryptoKey>,
  fallback: CryptoKey,
): CryptoKey {
  const oldestVersion = [...keys.keys()].sort((left, right) => left - right)[0]
  return oldestVersion === undefined ? fallback : keys.get(oldestVersion) ?? fallback
}

export function getSyncV2StableBlindIndexKeyVersion(keys: ReadonlyMap<number, CryptoKey>): number {
  return [...keys.keys()].sort((left, right) => left - right)[0] ?? 1
}

function encodeAad(aad: SyncV2Aad): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    'notegen-sync-v1', aad.workspaceId, aad.objectId, aad.kind,
    aad.keyVersion, aad.purpose, aad.identity,
  ]))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}
