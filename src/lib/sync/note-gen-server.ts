import { Store } from '@tauri-apps/plugin-store'
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { invoke } from '@tauri-apps/api/core'

const PROFILE_KEY = 'noteGenServerSyncProfile'
const SESSION_KEY = 'noteGenServerSyncSession'
const PBKDF2_ITERATIONS = 210_000

export interface NoteGenServerProfile {
  baseUrl: string
  instanceId: string
  serverName: string
  login: string
  deviceId: string
  enabled?: boolean
  workspaceId?: string
  localWorkspaceKey?: string
  encryptionMode?: 'managed' | 'e2ee'
}

export interface ServerCapabilities {
  service: 'note-gen-server'
  instanceId: string
  serverName: string
  serverVersion: string
  protocol: { minimum: number, maximum: number }
  registrationMode: 'closed' | 'open'
  deploymentMode?: 'self-hosted' | 'hosted'
  features?: {
    webAccountPortal?: boolean
    deviceAuthorization?: boolean
    devicePairing?: boolean
    manualDeviceToken?: boolean
    managedDefaultWorkspace?: boolean
    blobUpload?: boolean
    resumableBlobUploads?: boolean
  }
  limits?: {
    maxBatchOperations: number
    maxObjectBytes: number
    maxRequestBytes: number
    maxBlobBytes: number
    blobPartBytes: number
  }
  web?: {
    accountUrl: string
    deviceAuthorizationUrl: string
  }
}

export interface ServerSession {
  accountId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
}

export interface ServerAccount {
  id: string
  login: string
}

export interface DeviceAuthorizationCreated {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

interface StoredServerSession {
  instanceId: string
  session: ServerSession
}

export interface ServerWorkspace {
  id: string
  nameCiphertext: string
  latestSequence: string
  latestKeyVersion: number
  hasDeviceEnvelope: boolean
  encryptionMode: 'managed' | 'e2ee'
}

export interface UnlockedWorkspaceKey {
  key: CryptoKey
  keyVersion: number
  keys: ReadonlyMap<number, CryptoKey>
}

interface KeyEnvelope {
  type: 'passphrase' | 'recovery' | 'device' | 'managed'
  wrappedKey: string
  kdfSalt: string | null
  kdfParams: Record<string, number> | null
}

interface WorkspaceKeyVersion {
  keyVersion: number
  envelopes: KeyEnvelope[]
}

export interface PushResult {
  operationId: string
  status: 'applied' | 'conflict' | 'rejected'
  revision?: string
  sequence?: string
  duplicate?: boolean
  code?: string
  retryable?: boolean
  current?: ServerObjectSnapshot | null
}

export interface ServerChange {
  sequence: string
  objectId: string
  revision: string
  operationId: string
  sourceDeviceId: string
  changeType: 'upsert' | 'delete'
  kind: string
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefs: string[]
  deleted: boolean
  createdAt: string
}

export interface ServerChangePage {
  changes: ServerChange[]
  nextCursor: string
  hasMore: boolean
  latestSequence: string
}

export interface ServerObjectSnapshot {
  objectId: string
  currentRevision: string
  kind: string
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefs: string[]
  deletedAt: string | null
}

export interface EncryptedWorkspaceOperation {
  operationId: string
  objectId: string
  kind: 'note' | 'folder' | 'asset' | 'canvas' | 'record' | 'tag' | 'mark' | 'conversation' | 'memory' | 'setting' | 'yjs-checkpoint' | 'yjs-update'
  baseRevision: string | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
  delete: boolean
}

export async function loadServerProfile(): Promise<NoteGenServerProfile | null> {
  if (!isTauriRuntime()) {
    const value = localStorage.getItem(PROFILE_KEY)
    return value ? JSON.parse(value) as NoteGenServerProfile : null
  }
  const store = await Store.load('store.json')
  return await store.get<NoteGenServerProfile>(PROFILE_KEY) ?? null
}

export async function saveServerProfile(profile: NoteGenServerProfile): Promise<void> {
  if (!isTauriRuntime()) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
    return
  }
  const store = await Store.load('store.json')
  await store.set(PROFILE_KEY, profile)
  await store.save()
}

export async function clearServerProfile(): Promise<void> {
  if (!isTauriRuntime()) {
    localStorage.removeItem(PROFILE_KEY)
    localStorage.removeItem(SESSION_KEY)
    return
  }
  const store = await Store.load('store.json')
  await store.delete(PROFILE_KEY)
  await store.delete(SESSION_KEY)
  await store.save()
}

export async function loadServerSession(instanceId: string): Promise<ServerSession | null> {
  const stored = !isTauriRuntime()
    ? parseStoredSession(localStorage.getItem(SESSION_KEY))
    : await (await Store.load('store.json')).get<StoredServerSession>(SESSION_KEY) ?? null
  return stored?.instanceId === instanceId ? stored.session : null
}

export async function saveServerSession(instanceId: string, session: ServerSession): Promise<void> {
  const stored: StoredServerSession = { instanceId, session }
  if (!isTauriRuntime()) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(stored))
    return
  }
  const store = await Store.load('store.json')
  await store.set(SESSION_KEY, stored)
  await store.save()
}

export async function clearServerSession(): Promise<void> {
  if (!isTauriRuntime()) {
    localStorage.removeItem(SESSION_KEY)
    return
  }
  const store = await Store.load('store.json')
  await store.delete(SESSION_KEY)
  await store.save()
}

export async function getOrCreateServerDeviceId(): Promise<string> {
  if (!isTauriRuntime()) {
    const existing = localStorage.getItem('noteGenServerDeviceId')
    if (existing) return existing
    const deviceId = crypto.randomUUID()
    localStorage.setItem('noteGenServerDeviceId', deviceId)
    return deviceId
  }
  const store = await Store.load('store.json')
  try {
    const machineId = await invoke<string>('get_device_id')
    if (machineId.trim()) {
      const stableDeviceId = await createStableDeviceUuid(machineId)
      const storedMachineId = await store.get<string>('noteGenServerMachineId')
      const existing = await store.get<string>('noteGenServerDeviceId')
      if (storedMachineId === machineId && existing) return existing

      // Migrate IDs generated by the old random-UUID implementation, and
      // also prevent a restored store from making this machine impersonate
      // the device that originally created the backup.
      await store.set('noteGenServerMachineId', machineId)
      await store.set('noteGenServerDeviceId', stableDeviceId)
      await store.save()
      return stableDeviceId
    }
  } catch (error) {
    console.warn('Failed to derive a stable NoteGen Server device ID:', error)
  }
  const existing = await store.get<string>('noteGenServerDeviceId')
  if (existing) return existing
  const deviceId = crypto.randomUUID()
  await store.set('noteGenServerDeviceId', deviceId)
  await store.save()
  return deviceId
}

async function createStableDeviceUuid(machineId: string): Promise<string> {
  const source = new TextEncoder().encode(`notegen-server-device\0${machineId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source))
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function getNoteGenServerSyncScopeId(profile: NoteGenServerProfile): Promise<string> {
  if (!profile.workspaceId || !profile.localWorkspaceKey) {
    throw new Error('NoteGen Server sync scope is incomplete')
  }
  const source = `${profile.instanceId}\0${profile.workspaceId}\0${profile.localWorkspaceKey}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  return `ngs:${hex}`
}

export async function discoverServer(baseUrl: string): Promise<ServerCapabilities> {
  const normalized = normalizeServerOrigin(baseUrl)
  const [ready, capabilities] = await Promise.all([
    serverRequest<{ status: string }>(normalized, '/health/ready', { timeoutMs: 5_000 }),
    serverRequest<ServerCapabilities>(normalized, '/v1/capabilities', { timeoutMs: 5_000 }),
  ])
  if (ready.status !== 'ok') throw new Error('Server is not ready')
  if (capabilities.service !== 'note-gen-server') throw new Error('The address is not a NoteGen Sync Server')
  if (capabilities.protocol.minimum > 1 || capabilities.protocol.maximum < 1) {
    throw new Error('The server protocol is incompatible with this NoteGen version')
  }
  return capabilities
}

export async function authenticateServer(input: {
  baseUrl: string
  action: 'login' | 'register'
  login: string
  password: string
  setupToken?: string
  deviceId: string
  deviceName: string
}): Promise<ServerSession> {
  return await serverRequest<ServerSession>(normalizeServerOrigin(input.baseUrl), `/v1/auth/${input.action}`, {
    method: 'POST',
    headers: input.action === 'register' && input.setupToken
      ? { 'x-setup-token': input.setupToken }
      : undefined,
    body: {
      login: input.login.trim(),
      password: input.password,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: 'notegen',
    },
    expectedStatus: input.action === 'register' ? 201 : 200,
  })
}

export async function createServerDeviceAuthorization(input: {
  baseUrl: string
  deviceId: string
  deviceName: string
}): Promise<DeviceAuthorizationCreated> {
  return await serverRequest(normalizeServerOrigin(input.baseUrl), '/v1/device-authorizations', {
    method: 'POST',
    expectedStatus: 201,
    body: {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: 'notegen',
    },
  })
}

export async function exchangeServerDeviceAuthorization(
  baseUrl: string,
  deviceCode: string,
): Promise<ServerSession> {
  return await serverRequest(normalizeServerOrigin(baseUrl), '/v1/device-authorizations/token', {
    method: 'POST',
    body: { deviceCode },
  })
}

export async function exchangeServerDevicePairing(input: {
  baseUrl: string
  pairingToken: string
  deviceId: string
  deviceName: string
}): Promise<ServerSession> {
  return await serverRequest(normalizeServerOrigin(input.baseUrl), '/v1/device-pairings/exchange', {
    method: 'POST',
    body: {
      pairingToken: input.pairingToken,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: 'notegen',
    },
  })
}

export async function cancelServerDeviceAuthorization(baseUrl: string, deviceCode: string): Promise<void> {
  await serverRequest(normalizeServerOrigin(baseUrl), '/v1/device-authorizations/cancel', {
    method: 'POST',
    expectedStatus: 204,
    body: { deviceCode },
  })
}

export async function refreshServerSession(input: {
  baseUrl: string
  refreshToken: string
  deviceId: string
}): Promise<ServerSession> {
  return await serverRequest(normalizeServerOrigin(input.baseUrl), '/v1/auth/refresh', {
    method: 'POST',
    timeoutMs: 8_000,
    body: { refreshToken: input.refreshToken, deviceId: input.deviceId },
  })
}

export async function logoutServerSession(input: {
  baseUrl: string
  refreshToken: string
  deviceId: string
}): Promise<void> {
  await serverRequest(normalizeServerOrigin(input.baseUrl), '/v1/auth/logout', {
    method: 'POST',
    expectedStatus: 204,
    body: { refreshToken: input.refreshToken, deviceId: input.deviceId },
  })
}

export async function getServerAccount(baseUrl: string, accessToken: string): Promise<ServerAccount> {
  return await serverRequest(normalizeServerOrigin(baseUrl), '/v1/account', { accessToken, timeoutMs: 8_000 })
}

export async function listServerWorkspaces(baseUrl: string, accessToken: string): Promise<ServerWorkspace[]> {
  return await serverRequest(normalizeServerOrigin(baseUrl), '/v1/workspaces', { accessToken, timeoutMs: 8_000 })
}

export async function createServerWorkspace(input: {
  baseUrl: string
  accessToken: string
  name: string
  syncPassphrase: string
}): Promise<{ workspace: { id: string }, workspaceKey: CryptoKey, workspaceKeys: ReadonlyMap<number, CryptoKey>, recoveryKey: string }> {
  const workspaceKeyBytes = randomBytes(32)
  const workspaceKey = await importAesKey(workspaceKeyBytes)
  const passphraseSalt = randomBytes(16)
  const passphraseKey = await derivePassphraseKey(input.syncPassphrase, passphraseSalt, PBKDF2_ITERATIONS)
  const recoveryKeyBytes = randomBytes(32)
  const recoveryKey = await importAesKey(recoveryKeyBytes)
  const nameCiphertext = await encryptText(workspaceKey, input.name)

  const workspace = await serverRequest<{ id: string }>(normalizeServerOrigin(input.baseUrl), '/v1/workspaces', {
    method: 'POST',
    expectedStatus: 201,
    accessToken: input.accessToken,
    body: {
      nameCiphertext,
      keyVersion: 1,
      envelopes: [
        {
          type: 'passphrase',
          recipientId: null,
          wrappedKey: await encryptBytes(passphraseKey, workspaceKeyBytes),
          kdfSalt: toBase64Url(passphraseSalt),
          kdfParams: { iterations: PBKDF2_ITERATIONS, hashBits: 256 },
        },
        {
          type: 'recovery',
          recipientId: null,
          wrappedKey: await encryptBytes(recoveryKey, workspaceKeyBytes),
          kdfSalt: null,
          kdfParams: null,
        },
      ],
    },
  })
  return {
    workspace,
    workspaceKey,
    workspaceKeys: new Map([[1, workspaceKey]]),
    recoveryKey: toBase64Url(recoveryKeyBytes),
  }
}

export async function getOrCreateManagedServerWorkspace(input: {
  baseUrl: string
  accessToken: string
  name?: string
}): Promise<{
  workspace: { id: string, created: boolean, encryptionMode: 'managed' | 'e2ee' }
  unlocked: UnlockedWorkspaceKey | null
}> {
  const candidateKeyBytes = randomBytes(32)
  const candidateKey = await importAesKey(candidateKeyBytes)
  const workspace = await serverRequest<{
    id: string
    created: boolean
    encryptionMode: 'managed' | 'e2ee'
  }>(
    normalizeServerOrigin(input.baseUrl),
    '/v1/workspaces/default',
    {
      method: 'POST',
      accessToken: input.accessToken,
      timeoutMs: 8_000,
      body: {
        nameCiphertext: await encryptText(candidateKey, input.name ?? 'NoteGen'),
        managedKey: toBase64Url(candidateKeyBytes),
      },
    },
  )
  return {
    workspace,
    unlocked: workspace.encryptionMode === 'managed'
      ? await unlockServerWorkspace({
          baseUrl: input.baseUrl,
          accessToken: input.accessToken,
          workspaceId: workspace.id,
        })
      : null,
  }
}

export async function unlockServerWorkspace(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  syncPassphrase?: string
  recoveryKey?: string
}): Promise<UnlockedWorkspaceKey> {
  const unlockMode = input.recoveryKey
    ? 'recovery'
    : input.syncPassphrase
      ? 'passphrase'
      : 'managed'
  const versions = await serverRequest<WorkspaceKeyVersion[]>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/keys`,
    { accessToken: input.accessToken, timeoutMs: 8_000 },
  )
  const sortedVersions = [...versions].sort((a, b) => b.keyVersion - a.keyVersion)
  const latest = sortedVersions[0]
  if (!latest) throw new Error('Workspace has no key versions')
  const keys = new Map<number, CryptoKey>()
  const recoveryKey = input.recoveryKey
    ? await importRecoveryKey(input.recoveryKey)
    : null
  try {
    for (const version of sortedVersions) {
      const envelope = version.envelopes.find(item => item.type === unlockMode)
      if (!envelope) continue
      try {
        const keyBytes = envelope.type === 'managed'
          ? fromBase64Url(envelope.wrappedKey)
          : await decryptBytes(
              recoveryKey ?? await deriveEnvelopePassphraseKey(input.syncPassphrase, envelope),
              envelope.wrappedKey,
            )
        if (keyBytes.byteLength !== 32) throw new Error('Workspace key has an invalid length')
        keys.set(version.keyVersion, await importAesKey(keyBytes))
      } catch {
        if (version.keyVersion === latest.keyVersion) throw new Error('Latest workspace key cannot be decrypted')
      }
    }
    const key = keys.get(latest.keyVersion)
    if (!key) throw new Error('Latest workspace key has no compatible envelope')
    return {
      key,
      keyVersion: latest.keyVersion,
      keys,
    }
  } catch {
    throw new Error(unlockMode === 'managed'
      ? 'The server-managed sync key is unavailable'
      : unlockMode === 'recovery'
        ? 'The recovery key is incorrect'
        : 'The sync passphrase is incorrect')
  }
}

export async function enableServerWorkspaceEndToEndEncryption(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKey: CryptoKey
  keyVersion: number
  syncPassphrase: string
}): Promise<string> {
  const workspaceKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', input.workspaceKey))
  const passphraseSalt = randomBytes(16)
  const passphraseKey = await derivePassphraseKey(
    input.syncPassphrase,
    passphraseSalt,
    PBKDF2_ITERATIONS,
  )
  const recoveryKeyBytes = randomBytes(32)
  const recoveryKey = await importAesKey(recoveryKeyBytes)
  await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/keys/${input.keyVersion}/encryption/e2ee`,
    {
      method: 'PUT',
      expectedStatus: 204,
      accessToken: input.accessToken,
      body: {
        envelopes: [
          {
            type: 'passphrase',
            recipientId: null,
            wrappedKey: await encryptBytes(passphraseKey, workspaceKeyBytes),
            kdfSalt: toBase64Url(passphraseSalt),
            kdfParams: { iterations: PBKDF2_ITERATIONS, hashBits: 256 },
          },
          {
            type: 'recovery',
            recipientId: null,
            wrappedKey: await encryptBytes(recoveryKey, workspaceKeyBytes),
            kdfSalt: null,
            kdfParams: null,
          },
        ],
      },
    },
  )
  return toBase64Url(recoveryKeyBytes)
}

export async function enableServerWorkspaceManagedEncryption(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
}): Promise<void> {
  const keys = await Promise.all([...input.workspaceKeys.entries()].map(async ([keyVersion, key]) => ({
    keyVersion,
    managedKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key))),
  })))
  await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/encryption/managed`,
    {
      method: 'PUT',
      expectedStatus: 204,
      accessToken: input.accessToken,
      body: { keys },
    },
  )
}

async function deriveEnvelopePassphraseKey(
  syncPassphrase: string | undefined,
  envelope: KeyEnvelope,
): Promise<CryptoKey> {
  const iterations = envelope.kdfParams?.iterations
  if (!syncPassphrase || !envelope.kdfSalt || !iterations) {
    throw new Error('Workspace has no compatible passphrase envelope')
  }
  return await derivePassphraseKey(syncPassphrase, fromBase64Url(envelope.kdfSalt), iterations)
}

async function importRecoveryKey(value: string): Promise<CryptoKey> {
  const normalized = value.trim()
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) throw new Error('invalid format')
    const bytes = fromBase64Url(normalized)
    if (bytes.byteLength !== 32 || toBase64Url(bytes) !== normalized) throw new Error('invalid bytes')
    return await importAesKey(bytes)
  } catch {
    throw new Error('The recovery key is invalid')
  }
}

export async function runServerWorkspaceTest(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  workspaceKey: CryptoKey
  keyVersion: number
}): Promise<{ sequence: string }> {
  const objectId = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const ciphertext = await encryptText(input.workspaceKey, JSON.stringify({
    schemaVersion: 1,
    type: 'connection-test',
    createdAt: new Date().toISOString(),
  }))
  const ciphertextHash = await sha256Base64Url(fromBase64Url(ciphertext))
  const pushed = await pushOperation(input, {
    operationId,
    objectId,
    kind: 'setting',
    baseRevision: null,
    keyVersion: input.keyVersion,
    ciphertext,
    ciphertextHash,
    blobRefs: [],
    delete: false,
  })
  if (pushed.status !== 'applied' || !pushed.sequence || !pushed.revision) {
    throw new Error(`Connection test Push failed: ${pushed.code ?? pushed.status}`)
  }

  const pulled = await serverRequest<{ changes: Array<{ operationId: string, ciphertext: string }> }>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/changes?after=${decrementCounter(pushed.sequence)}`,
    { accessToken: input.accessToken },
  )
  const change = pulled.changes.find(item => item.operationId === operationId)
  if (!change) throw new Error('Connection test Pull did not return the pushed object')
  const plaintext = await decryptText(input.workspaceKey, change.ciphertext)
  const parsed = JSON.parse(plaintext) as { type?: string }
  if (parsed.type !== 'connection-test') throw new Error('Connection test payload verification failed')

  const deletedCiphertext = await encryptText(input.workspaceKey, '{}')
  const deletedHash = await sha256Base64Url(fromBase64Url(deletedCiphertext))
  const deleted = await pushOperation(input, {
    operationId: crypto.randomUUID(),
    objectId,
    kind: 'setting',
    baseRevision: pushed.revision,
    keyVersion: input.keyVersion,
    ciphertext: deletedCiphertext,
    ciphertextHash: deletedHash,
    blobRefs: [],
    delete: true,
  })
  if (deleted.status !== 'applied' || !deleted.sequence) throw new Error('Connection test cleanup failed')
  return { sequence: deleted.sequence }
}

export async function listServerWorkspaceObjects(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
}): Promise<{ objects: ServerObjectSnapshot[], snapshotSequence: string }> {
  const objects: ServerObjectSnapshot[] = []
  let afterObjectId: string | null = null
  let bootstrapSessionId: string | null = null
  let snapshotSequence = '0'

  do {
    const query = new URLSearchParams({ limit: '1000' })
    if (afterObjectId) query.set('afterObjectId', afterObjectId)
    if (bootstrapSessionId) query.set('bootstrapSessionId', bootstrapSessionId)
    const page = await serverRequest<{
      objects: ServerObjectSnapshot[]
      nextObjectId: string | null
      hasMore: boolean
      snapshotSequence: string
      bootstrapSessionId: string | null
    }>(
      normalizeServerOrigin(input.baseUrl),
      `/v1/workspaces/${input.workspaceId}/sync/bootstrap?${query.toString()}`,
      { accessToken: input.accessToken },
    )
    objects.push(...page.objects)
    snapshotSequence = page.snapshotSequence
    afterObjectId = page.hasMore ? page.nextObjectId : null
    bootstrapSessionId = page.hasMore ? page.bootstrapSessionId : null
  } while (afterObjectId)

  return { objects, snapshotSequence }
}

export async function createServerSyncSession(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  cursor: string
}): Promise<{
  latestSequence: string
  cursorValid: boolean
  bootstrapRequired: boolean
  webSocketPath: string
}> {
  return await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/session`,
    { method: 'POST', accessToken: input.accessToken, body: { cursor: input.cursor } },
  )
}

export async function pullServerChanges(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  after: string
  limit?: number
}): Promise<ServerChangePage> {
  const query = new URLSearchParams({
    after: input.after,
    limit: String(input.limit ?? 200),
  })
  return await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/changes?${query.toString()}`,
    { accessToken: input.accessToken },
  )
}

export async function acknowledgeServerCursor(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  cursor: string
}): Promise<void> {
  await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/cursor`,
    { method: 'PUT', expectedStatus: 204, accessToken: input.accessToken, body: { cursor: input.cursor } },
  )
}

export async function createEncryptedWorkspaceOperation(input: {
  operationId?: string
  workspaceKey: CryptoKey
  keyVersion: number
  objectId: string
  kind: EncryptedWorkspaceOperation['kind']
  baseRevision: string | null
  payload: unknown
  blobRefs?: string[]
  delete?: boolean
}): Promise<EncryptedWorkspaceOperation> {
  const operationId = input.operationId ?? crypto.randomUUID()
  const ciphertext = await encryptWorkspaceJson(input.workspaceKey, input.payload, operationId)
  return {
    operationId,
    objectId: input.objectId,
    kind: input.kind,
    baseRevision: input.baseRevision,
    keyVersion: input.keyVersion,
    ciphertext,
    ciphertextHash: await sha256Base64Url(fromBase64Url(ciphertext)),
    blobRefs: input.blobRefs ?? [],
    delete: input.delete ?? false,
  }
}

export async function pushServerOperationBatch(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  operations: EncryptedWorkspaceOperation[]
}): Promise<PushResult[]> {
  if (input.operations.length === 0) return []
  if (input.operations.length > 100) throw new Error('A Push batch cannot contain more than 100 operations')
  const response = await serverRequest<{ results: PushResult[] }>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/sync/push`,
    { method: 'POST', accessToken: input.accessToken, body: { operations: input.operations } },
  )
  return response.results
}

export async function decryptWorkspacePayload<T>(workspaceKey: CryptoKey, ciphertext: string): Promise<T> {
  const plaintext = await decryptBytes(workspaceKey, ciphertext)
  const bytes = hasBytePrefix(plaintext, [0x4e, 0x47, 0x5a, 0x31])
    ? await decompressGzip(plaintext.slice(4))
    : plaintext
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

export interface EncryptedServerBlob {
  blobId: string
  ciphertextHash: string
  ciphertext: Uint8Array
}

export async function encryptServerBlob(
  workspaceKey: CryptoKey,
  plaintext: Uint8Array,
): Promise<EncryptedServerBlob> {
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', workspaceKey))
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const plaintextHash = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext))
  const ivMaterial = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, plaintextHash))
  const iv = ivMaterial.slice(0, 12)
  const additionalData = new TextEncoder().encode('notegen-server-blob-v1')
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    workspaceKey,
    plaintext,
  ))
  const ciphertext = new Uint8Array(4 + iv.length + encrypted.length)
  ciphertext.set([0x4e, 0x47, 0x42, 0x31])
  ciphertext.set(iv, 4)
  ciphertext.set(encrypted, 16)
  const ciphertextHash = await sha256Base64Url(ciphertext)
  return { blobId: ciphertextHash, ciphertextHash, ciphertext }
}

export async function decryptServerBlob(
  workspaceKey: CryptoKey,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length <= 32
    || ciphertext[0] !== 0x4e || ciphertext[1] !== 0x47
    || ciphertext[2] !== 0x42 || ciphertext[3] !== 0x31) {
    throw new Error('服务器 Blob 使用了不兼容的加密格式')
  }
  const additionalData = new TextEncoder().encode('notegen-server-blob-v1')
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ciphertext.slice(4, 16), additionalData },
    workspaceKey,
    ciphertext.slice(16),
  ))
}

export async function uploadServerBlob(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  blob: EncryptedServerBlob
}): Promise<void> {
  const upload = await serverRequest<{
    alreadyExists: boolean
    uploadId: string | null
    partBytes: number
    uploadedParts: Array<{ partNumber: number }>
  }>(normalizeServerOrigin(input.baseUrl), `/v1/workspaces/${input.workspaceId}/blobs/uploads`, {
    method: 'POST',
    accessToken: input.accessToken,
    expectedStatus: [200, 201],
    body: {
      blobId: input.blob.blobId,
      expectedSize: String(input.blob.ciphertext.byteLength),
      ciphertextHash: input.blob.ciphertextHash,
    },
  })
  if (upload.alreadyExists) return
  if (!upload.uploadId || upload.partBytes <= 0) throw new Error('服务器返回了无效的 Blob 上传会话')
  const uploadedParts = new Set(upload.uploadedParts.map(part => part.partNumber))
  const partCount = Math.ceil(input.blob.ciphertext.byteLength / upload.partBytes)
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (uploadedParts.has(partNumber)) continue
    const start = (partNumber - 1) * upload.partBytes
    const end = Math.min(input.blob.ciphertext.byteLength, start + upload.partBytes)
    await binaryServerRequest(
      normalizeServerOrigin(input.baseUrl),
      `/v1/workspaces/${input.workspaceId}/blobs/uploads/${upload.uploadId}/parts/${partNumber}`,
      {
        method: 'PUT',
        accessToken: input.accessToken,
        body: input.blob.ciphertext.slice(start, end),
      },
    )
  }
  await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/blobs/uploads/${upload.uploadId}/complete`,
    { method: 'POST', accessToken: input.accessToken },
  )
}

export async function downloadServerBlob(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  blobId: string
  workspaceKey: CryptoKey
}): Promise<Uint8Array> {
  const response = await binaryServerRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/blobs/${input.blobId}`,
    { accessToken: input.accessToken },
  )
  const ciphertextHash = await sha256Base64Url(response)
  if (ciphertextHash !== input.blobId) throw new Error('服务器 Blob 完整性校验失败')
  return await decryptServerBlob(input.workspaceKey, response)
}

export async function createDeterministicNoteObjectId(workspaceId: string, relativePath: string): Promise<string> {
  const normalizedPath = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
  return await createDeterministicServerObjectId(workspaceId, 'note', normalizedPath)
}

export async function createDeterministicServerObjectId(
  workspaceId: string,
  kind: string,
  logicalKey: string,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${workspaceId}\0${kind}\0${logicalKey}`),
  )).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function pushOperation(
  input: { baseUrl: string, accessToken: string, workspaceId: string },
  operation: Record<string, unknown>,
): Promise<PushResult> {
  const results = await pushServerOperationBatch({
    ...input,
    operations: [operation as unknown as EncryptedWorkspaceOperation],
  })
  const result = results[0]
  if (!result) throw new Error('Server returned an empty Push response')
  return result
}

export class NoteGenServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'NoteGenServerRequestError'
  }
}

async function serverRequest<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    accessToken?: string
    expectedStatus?: number | number[]
    timeoutMs?: number
  } = {},
): Promise<T> {
  const request = isTauriRuntime() ? httpFetch : globalThis.fetch
  const timeoutController = new AbortController()
  const timeout = globalThis.setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 30_000)
  let response: Response
  try {
    response = await request(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: timeoutController.signal,
    })
  } catch (cause) {
    if (timeoutController.signal.aborted) throw new Error('Sync server request timed out')
    throw cause
  } finally {
    globalThis.clearTimeout(timeout)
  }
  const text = await response.text()
  const expectedStatuses = Array.isArray(options.expectedStatus)
    ? options.expectedStatus
    : [options.expectedStatus ?? 200]
  if (!expectedStatuses.includes(response.status)) {
    let message = text || `HTTP ${response.status}`
    let code: string | undefined
    let retryable = false
    try {
      const body = JSON.parse(text) as { message?: string, code?: string, retryable?: boolean }
      code = body.code
      retryable = body.retryable ?? false
      message = body.message ? `${body.message}${body.code ? ` (${body.code})` : ''}` : message
    } catch {
      // Keep the raw response.
    }
    throw new NoteGenServerRequestError(message, response.status, code, retryable)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

async function binaryServerRequest(
  baseUrl: string,
  path: string,
  options: { method?: string, accessToken: string, body?: Uint8Array },
): Promise<Uint8Array> {
  const request = isTauriRuntime() ? httpFetch : globalThis.fetch
  const timeoutController = new AbortController()
  const timeout = globalThis.setTimeout(() => timeoutController.abort(), 120_000)
  let response: Response
  try {
    response = await request(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        ...(options.body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
      signal: timeoutController.signal,
    })
  } catch (cause) {
    if (timeoutController.signal.aborted) throw new Error('Sync server transfer timed out')
    throw cause
  } finally {
    globalThis.clearTimeout(timeout)
  }
  if (!response.ok) {
    const text = await response.text()
    let message = text || `HTTP ${response.status}`
    let code: string | undefined
    let retryable = false
    try {
      const body = JSON.parse(text) as { message?: string, code?: string, retryable?: boolean }
      code = body.code
      retryable = body.retryable ?? false
      message = body.message ? `${body.message}${body.code ? ` (${body.code})` : ''}` : message
    } catch {
      // Keep the raw response.
    }
    throw new NoteGenServerRequestError(message, response.status, code, retryable)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export function normalizeServerOrigin(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server URL must use HTTP or HTTPS')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number)
  const local = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:')
    || Boolean(ipv4
      && ipv4.every(part => part >= 0 && part <= 255)
      && (ipv4[0] === 10
        || ipv4[0] === 127
        || (ipv4[0] === 169 && ipv4[1] === 254)
        || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
        || (ipv4[0] === 192 && ipv4[1] === 168)))
  if (url.protocol !== 'https:' && !local) throw new Error('Remote sync servers must use HTTPS')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Server URL must be an origin without a path or credentials')
  }
  return url.origin
}

async function derivePassphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

async function encryptText(key: CryptoKey, value: string): Promise<string> {
  return await encryptBytes(key, new TextEncoder().encode(value))
}

async function encryptWorkspaceJson(key: CryptoKey, value: unknown, operationId: string): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  if (plaintext.byteLength < 64 * 1024 || typeof CompressionStream === 'undefined') {
    return await encryptBytes(key, plaintext, await deriveOperationIv(key, operationId, plaintext))
  }
  const compressed = await compressGzip(plaintext)
  if (compressed.byteLength + 4 >= plaintext.byteLength) {
    return await encryptBytes(key, plaintext, await deriveOperationIv(key, operationId, plaintext))
  }
  const payload = new Uint8Array(4 + compressed.byteLength)
  payload.set([0x4e, 0x47, 0x5a, 0x31])
  payload.set(compressed, 4)
  return await encryptBytes(key, payload, await deriveOperationIv(key, operationId, payload))
}

async function decryptText(key: CryptoKey, value: string): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, value))
}

async function encryptBytes(key: CryptoKey, value: Uint8Array, suppliedIv?: Uint8Array): Promise<string> {
  const iv = suppliedIv ?? randomBytes(12)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, value))
  const result = new Uint8Array(iv.length + encrypted.length)
  result.set(iv)
  result.set(encrypted, iv.length)
  return toBase64Url(result)
}

async function deriveOperationIv(
  key: CryptoKey,
  operationId: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const hmacKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const operationBytes = new TextEncoder().encode(`notegen-operation-v1:${operationId}`)
  const payloadHash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
  const material = new Uint8Array(operationBytes.length + payloadHash.length)
  material.set(operationBytes)
  material.set(payloadHash, operationBytes.length)
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, material)).slice(0, 12)
}

async function decryptBytes(key: CryptoKey, value: string): Promise<Uint8Array> {
  const bytes = fromBase64Url(value)
  if (bytes.length <= 12) throw new Error('Encrypted payload is invalid')
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  ))
}

/** Encrypts a transient Yjs update without exposing its contents to the sync server. */
export async function encryptNoteGenServerCollaborationUpdate(
  workspaceKey: CryptoKey,
  update: Uint8Array,
): Promise<string> {
  return encryptBytes(workspaceKey, update)
}

/** Decrypts a transient Yjs update received from the collaboration room. */
export async function decryptNoteGenServerCollaborationUpdate(
  workspaceKey: CryptoKey,
  ciphertext: string,
): Promise<Uint8Array> {
  return decryptBytes(workspaceKey, ciphertext)
}

async function compressGzip(value: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompressGzip(value: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前系统不支持解压远端同步对象')
  const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function hasBytePrefix(value: Uint8Array, prefix: number[]): boolean {
  return value.length >= prefix.length && prefix.every((byte, index) => value[index] === byte)
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in globalThis
}

function parseStoredSession(value: string | null): StoredServerSession | null {
  if (!value) return null
  try {
    return JSON.parse(value) as StoredServerSession
  } catch {
    return null
  }
}

function decrementCounter(value: string): string {
  if (!/^\d+$/.test(value) || /^0+$/.test(value)) throw new Error('Server returned an invalid sequence')
  const digits = value.split('')
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index])
    if (digit > 0) {
      digits[index] = String(digit - 1)
      break
    }
    digits[index] = '9'
  }
  return digits.join('').replace(/^0+(?=\d)/, '')
}
