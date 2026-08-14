import { normalizeServerOrigin, serverRequest } from './note-gen-server'

export type SyncObjectKind =
  | 'note' | 'folder' | 'asset' | 'canvas' | 'record' | 'tag' | 'mark'
  | 'conversation' | 'memory' | 'setting' | 'yjs-checkpoint' | 'yjs-update'

export interface SyncEvent {
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

export type SyncCommand = Record<string, unknown> & {
  commandId: string
  type: string
  objectId?: string
  documentId?: string
}

export interface SyncCommandResult {
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

export interface SyncHistoricalObjectVersion {
  workspaceId: string
  objectId: string
  revision: string
  sequence: string
  kind: SyncObjectKind
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

export interface SyncAad {
  workspaceId: string
  objectId: string
  kind: string
  keyVersion: number
  purpose: 'object' | 'update' | 'checkpoint' | 'conflict'
  identity: string
}

export async function getSyncObjectVersion(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  objectId: string
  revision: string
  expectedSyncEpoch?: string
}): Promise<{
  object: SyncHistoricalObjectVersion
  resources: SyncHistoricalObjectVersion[]
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

export async function listSyncObjectVersions(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  objectId: string
  before?: string | null
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{
  versions: SyncHistoricalObjectVersion[]
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

export async function pushSyncCommands(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  expectedSyncEpoch?: string
  commands: SyncCommand[]
}): Promise<SyncCommandResult[]> {
  const response = await serverRequest<{ results: SyncCommandResult[] }>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/commands`,
    { method: 'POST', accessToken: input.accessToken, body: {
      commands: input.commands,
      ...(input.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: input.expectedSyncEpoch }),
    } },
  )
  return response.results
}

export async function pullSyncEvents(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  after: string
  limit?: number
  expectedSyncEpoch?: string
}): Promise<{ events: SyncEvent[], nextCursor: string, latestSequence: string, hasMore: boolean }> {
  const query = new URLSearchParams({ after: input.after, limit: String(input.limit ?? 200) })
  if (input.expectedSyncEpoch) query.set('expectedSyncEpoch', input.expectedSyncEpoch)
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/events?${query}`,
    { accessToken: input.accessToken },
  )
}

export async function acknowledgeSyncEvents(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  through: string
  expectedSyncEpoch?: string
}): Promise<{ acknowledgedSequence: string, syncEpoch?: string }> {
  return serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/ack`,
    { method: 'POST', accessToken: input.accessToken, body: {
      through: input.through,
      ...(input.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: input.expectedSyncEpoch }),
    } },
  )
}

export interface SyncBootstrapObject {
  objectId: string
  kind: SyncObjectKind
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

export interface SyncBootstrapConflict {
  conflictId: string
  objectId: string
  kind: SyncObjectKind
  type: string
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  createdSequence: string
}

export async function bootstrapSync(input: {
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
  objects: SyncBootstrapObject[]
  conflicts: SyncBootstrapConflict[]
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

export async function pullSyncDocumentUpdates(input: {
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

export async function encryptSyncPayload(
  key: CryptoKey,
  payload: unknown | Uint8Array,
  aad: SyncAad,
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

export async function decryptSyncPayload<T = unknown>(
  key: CryptoKey,
  ciphertext: string,
  aad: SyncAad,
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
export async function createSyncNameBlindIndex(input: {
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

/** Name indexes must survive content-key rotation, so sync anchors them to the
 * oldest retained workspace key instead of whichever key encrypts this command. */
export function getSyncStableBlindIndexKey(
  keys: ReadonlyMap<number, CryptoKey>,
  fallback: CryptoKey,
): CryptoKey {
  const oldestVersion = [...keys.keys()].sort((left, right) => left - right)[0]
  return oldestVersion === undefined ? fallback : keys.get(oldestVersion) ?? fallback
}

export function getSyncStableBlindIndexKeyVersion(keys: ReadonlyMap<number, CryptoKey>): number {
  return [...keys.keys()].sort((left, right) => left - right)[0] ?? 1
}

function encodeAad(aad: SyncAad): Uint8Array {
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
