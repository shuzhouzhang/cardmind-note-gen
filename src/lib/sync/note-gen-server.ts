import { Store } from '@tauri-apps/plugin-store'
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'

const PROFILE_KEY = 'noteGenServerSyncProfile'
const SESSION_KEY = 'noteGenServerSyncSession'
const DEVICE_IDS_KEY = 'noteGenServerDeviceIds'
const PENDING_ONBOARDING_SECRET_TTL_MS = 30 * 60 * 1000
let webRuntimeSession: StoredServerSession | null = null
let mobilePersistedSessionKey: string | null = null
const ARGON2_MEMORY_KIB = 64 * 1024
const ARGON2_ITERATIONS = 3
const ARGON2_PARALLELISM = 1

export interface NoteGenServerProfile {
  baseUrl: string
  instanceId: string
  /** Last accepted server epoch; a changed value requires staged recovery. */
  syncEpoch?: string
  serverName: string
  login: string
  deviceId: string
  enabled?: boolean
  workspaceId?: string
  localWorkspaceKey?: string
  encryptionMode?: 'managed' | 'e2ee'
  /** Non-secret journal for a foreground E2EE workspace creation. */
  onboarding?: {
    creationIdempotencyKey: string
    /** Stable across a foreground recovery-envelope replacement retry. */
    recoveryReplacementIdempotencyKey?: string
  }
}

/** An intentionally short-lived mobile-only recovery-key record. It never
 * reaches the settings Store, localStorage, diagnostics, or a local backup. */
interface PendingOnboardingSecret {
  version: 1
  instanceId: string
  accountId: string
  deviceId: string
  workspaceId: string
  creationIdempotencyKey: string
  recoveryKey: string
  expiresAt: number
}

export interface ServerCapabilities {
  service: 'note-gen-server'
  instanceId: string
  /** Additive on servers that have begun the restore-fencing rollout. */
  syncEpoch?: string
  serverName: string
  serverVersion: string
  protocol: { minimum: number, maximum: number }
  registrationMode: 'closed' | 'open'
  deploymentMode?: 'self-hosted' | 'hosted'
  /** Schema-2 fields are optional so older servers remain connectable. */
  capabilitySchema?: number
  instanceCapabilityRevision?: string
  registrationPolicyRevision?: string
  requiredSyncFeatures?: string[]
  registration?: {
    policy: 'bootstrap' | 'disabled' | 'invitation' | 'public'
    methods: string[]
    emailVerificationRequired: boolean
  }
  instanceCapabilities?: Record<string, boolean>
  features?: {
    webAccountPortal?: boolean
    deviceAuthorization?: boolean
    devicePairing?: boolean
    manualDeviceToken?: boolean
    managedDefaultWorkspace?: boolean
    blobUpload?: boolean
    resumableBlobUploads?: boolean
    durableCrdtUpdates?: boolean
    synchronizedConflicts?: boolean
    assetObjects?: boolean
    invitationRegistration?: boolean
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

export interface ResolvedServerCapabilities extends ServerCapabilities {
  registration: {
    policy: 'bootstrap' | 'disabled' | 'invitation' | 'public'
    methods: string[]
    emailVerificationRequired: boolean
  }
  instanceCapabilities: Readonly<Record<string, boolean>>
  requiredSyncFeatures: readonly string[]
  instanceCapabilityRevision: string
  registrationPolicyRevision: string
  /** Discovery remains useful when an otherwise valid server is draining or
   * temporarily unavailable. Authentication/sync still consult their own
   * endpoints and must not treat this as permission to proceed. */
  readiness: 'ready' | 'unavailable'
}

/**
 * Normalizes additive schema-2 discovery without making legacy servers look
 * incompatible. Callers must use this result rather than infer registration
 * methods from a deployment mode or a version number.
 */
export function resolveServerCapabilities(capabilities: ServerCapabilities): ResolvedServerCapabilities {
  const legacyPolicy = capabilities.registrationMode === 'open' ? 'public' : 'disabled'
  return {
    ...capabilities,
    registration: capabilities.registration ?? {
      policy: legacyPolicy,
      methods: capabilities.registrationMode === 'open' ? ['password'] : [],
      emailVerificationRequired: false,
    },
    instanceCapabilities: capabilities.instanceCapabilities ?? {},
    requiredSyncFeatures: capabilities.requiredSyncFeatures ?? [],
    instanceCapabilityRevision: capabilities.instanceCapabilityRevision ?? '0',
    registrationPolicyRevision: capabilities.registrationPolicyRevision ?? '0',
    readiness: 'ready',
  }
}

export interface ServerSession {
  accountId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  /** A mobile secure-storage journal survives only until its rotation response is committed. */
  refreshRequestId?: string
}

export interface ServerAccount {
  id: string
  login: string
}

/** Additive account-service projection. Server enforcement remains authoritative;
 * this is only a revisioned UI/scheduling hint for newer deployments. */
export interface ServerAccountContext {
  account: { id: string, login: string, isAdmin: boolean, totpEnabled: boolean }
  entitlements: { revision: string, features: Record<string, boolean>, limits: Record<string, string | number | null> }
  usage: { enforced: boolean, revision: string, metrics: Record<string, string>, updatedAt: string | null }
  restrictions: unknown[]
  actions: Record<string, { effect: 'allow' | 'deny', reasonCode: string }>
  accountContextRevision: string
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

/** Persisted only by Android/iOS Keychain/Keystore. Access tokens are never
 * included because a cold start must always rotate from the refresh token. */
interface MobileServerRefreshCredential {
  version: 1
  instanceId: string
  accountId: string
  deviceId: string
  refreshToken: string
  refreshRequestId?: string
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
  const existingProfile = await store.get<NoteGenServerProfile>(PROFILE_KEY)
  await store.delete(PROFILE_KEY)
  await store.delete(SESSION_KEY)
  await store.save()
  const secureStorage = mobileSecureStorage()
  const secureKey = mobilePersistedSessionKey ?? (isServerInstanceId(existingProfile?.instanceId ?? '')
    ? mobileSessionKey(existingProfile!.instanceId) : null)
  if (secureStorage !== null && secureKey !== null) {
    await invoke(secureStorage.deleteCommand, { key: secureKey }).catch(() => undefined)
  }
  mobilePersistedSessionKey = null
}

export async function loadServerSession(instanceId: string, expectedDeviceId?: string): Promise<ServerSession | null> {
  // Browser sessions are intentionally process-memory only. A Web account
  // cookie is not a cross-origin sync bearer credential, and localStorage is
  // not an acceptable refresh-token store.
  if (isTauriRuntime()) {
    const secureStorage = mobileSecureStorage()
    const store = await Store.load('store.json')
    await store.delete(SESSION_KEY)
    await store.save()
    if (secureStorage === null) return null
    const key = mobileSessionKey(instanceId)
    let raw: string | null
    try {
      raw = await invoke<string | null>(secureStorage.getCommand, { key })
    } catch {
      return null
    }
    const credential = parseMobileServerRefreshCredential(raw)
    if (credential !== null && credential.instanceId === instanceId
      && (expectedDeviceId === undefined || credential.deviceId === expectedDeviceId)) {
      mobilePersistedSessionKey = key
      return {
        accountId: credential.accountId, deviceId: credential.deviceId,
        refreshToken: credential.refreshToken, accessToken: '', accessTokenExpiresIn: 0,
        ...(credential.refreshRequestId === undefined ? {} : { refreshRequestId: credential.refreshRequestId }),
      }
    }
    if (raw !== null) await invoke(secureStorage.deleteCommand, { key }).catch(() => undefined)
    return null
  }
  const stored = webRuntimeSession
  return stored?.instanceId === instanceId ? stored.session : null
}

export async function saveServerSession(instanceId: string, session: ServerSession): Promise<void> {
  const stored: StoredServerSession = { instanceId, session }
  if (!isTauriRuntime()) {
    webRuntimeSession = stored
    return
  }
  const store = await Store.load('store.json')
  // Persisting a bearer refresh token in store.json is not an acceptable
  // substitute for OS secure storage. Keep it in the background runtime only.
  await store.delete(SESSION_KEY)
  await store.save()
  const secureStorage = mobileSecureStorage()
  if (secureStorage === null) return
  const credential: MobileServerRefreshCredential = {
    version: 1, instanceId, accountId: session.accountId, deviceId: session.deviceId, refreshToken: session.refreshToken,
  }
  if (!isServerInstanceId(instanceId) || !isServerInstanceId(session.accountId) || !isServerInstanceId(session.deviceId)
    || !isRefreshToken(session.refreshToken)) return
  const key = mobileSessionKey(instanceId)
  try {
    await invoke(secureStorage.setCommand, { key, value: JSON.stringify(credential) })
    mobilePersistedSessionKey = key
  } catch {
    // A locked mobile secure store only disables persistence. The current
    // in-memory authorization remains usable until the app exits.
  }
}

/**
 * Writes the pre-rotation credential before a mobile client asks the server
 * to rotate it. Callers must only send the request ID when this returns true:
 * otherwise a process death could turn a normal retry into token-reuse.
 */
export async function saveServerRefreshJournal(instanceId: string, session: ServerSession, refreshRequestId: string): Promise<boolean> {
  if (!isTauriRuntime() || !isServerInstanceId(refreshRequestId)) return false
  const storage = mobileSecureStorage()
  if (storage === null) return false
  const credential: MobileServerRefreshCredential = { version: 1, instanceId, accountId: session.accountId, deviceId: session.deviceId, refreshToken: session.refreshToken, refreshRequestId }
  if (!isServerInstanceId(instanceId) || !isServerInstanceId(session.accountId) || !isServerInstanceId(session.deviceId) || !isRefreshToken(session.refreshToken)) return false
  try {
    const key = mobileSessionKey(instanceId)
    await invoke(storage.setCommand, { key, value: JSON.stringify(credential) })
    mobilePersistedSessionKey = key
    return true
  } catch {
    return false
  }
}

export async function clearServerSession(): Promise<void> {
  if (!isTauriRuntime()) {
    webRuntimeSession = null
    // Scrub the legacy browser-store value during the compatible rollout.
    localStorage.removeItem(SESSION_KEY)
    return
  }
  const store = await Store.load('store.json')
  await store.delete(SESSION_KEY)
  await store.save()
  const secureStorage = mobileSecureStorage()
  if (secureStorage !== null && mobilePersistedSessionKey !== null) {
    await invoke(secureStorage.deleteCommand, { key: mobilePersistedSessionKey }).catch(() => undefined)
  }
  mobilePersistedSessionKey = null
}

/**
 * Records a just-created E2EE recovery key only when Android/iOS secure
 * storage is available. A false result is expected on desktop/web and keeps
 * the existing foreground-only confirmation flow intact.
 */
export async function savePendingServerWorkspaceRecoverySecret(input: {
  profile: Pick<NoteGenServerProfile, 'instanceId' | 'deviceId' | 'workspaceId' | 'onboarding'>
  accountId: string
  recoveryKey: string
}): Promise<boolean> {
  const workspaceId = input.profile.workspaceId
  const creationIdempotencyKey = input.profile.onboarding?.creationIdempotencyKey
  if (!workspaceId || !creationIdempotencyKey || !isServerInstanceId(input.profile.instanceId)
    || !isServerInstanceId(input.profile.deviceId) || !isServerInstanceId(input.accountId)
    || !isServerInstanceId(workspaceId) || !isBase64UrlSecret(input.recoveryKey)) return false
  const storage = mobileSecureStorage()
  if (storage === null) return false
  const value: PendingOnboardingSecret = {
    version: 1, instanceId: input.profile.instanceId, accountId: input.accountId,
    deviceId: input.profile.deviceId, workspaceId, creationIdempotencyKey,
    recoveryKey: input.recoveryKey, expiresAt: Date.now() + PENDING_ONBOARDING_SECRET_TTL_MS,
  }
  try {
    await invoke(storage.setCommand, { key: pendingOnboardingSecretKey(input.profile.instanceId, input.accountId, input.profile.deviceId), value: JSON.stringify(value) })
    return true
  } catch {
    // A locked/unavailable secure store must not turn a foreground-only
    // confirmation into a failed workspace creation.
    return false
  }
}

/** Reads a matching non-expired mobile pending record and removes malformed,
 * expired, or cross-account values before they can influence onboarding. */
export async function loadPendingServerWorkspaceRecoverySecret(input: {
  profile: Pick<NoteGenServerProfile, 'instanceId' | 'deviceId' | 'workspaceId' | 'onboarding'>
  accountId: string
}): Promise<string | null> {
  const storage = mobileSecureStorage()
  const creationIdempotencyKey = input.profile.onboarding?.creationIdempotencyKey
  const workspaceId = input.profile.workspaceId
  if (storage === null || !creationIdempotencyKey || !workspaceId) return null
  const key = pendingOnboardingSecretKey(input.profile.instanceId, input.accountId, input.profile.deviceId)
  let raw: string | null
  try {
    raw = await invoke<string | null>(storage.getCommand, { key })
  } catch {
    return null
  }
  const parsed = parsePendingOnboardingSecret(raw)
  if (parsed !== null && parsed.instanceId === input.profile.instanceId && parsed.accountId === input.accountId
    && parsed.deviceId === input.profile.deviceId && parsed.workspaceId === workspaceId
    && parsed.creationIdempotencyKey === creationIdempotencyKey) return parsed.recoveryKey
  if (raw !== null) await invoke(storage.deleteCommand, { key }).catch(() => undefined)
  return null
}

export async function clearPendingServerWorkspaceRecoverySecret(input: {
  instanceId: string
  accountId: string
  deviceId: string
}): Promise<void> {
  const storage = mobileSecureStorage()
  if (storage === null || !isServerInstanceId(input.instanceId) || !isServerInstanceId(input.accountId) || !isServerInstanceId(input.deviceId)) return
  await invoke(storage.deleteCommand, { key: pendingOnboardingSecretKey(input.instanceId, input.accountId, input.deviceId) })
}

/** Device IDs are opaque per-server pseudonyms, never a cross-instance machine identifier. */
export async function getOrCreateServerDeviceId(instanceId: string, legacyDeviceId?: string): Promise<string> {
  if (!isServerInstanceId(instanceId)) throw new Error('Server instance ID is invalid')
  if (!isTauriRuntime()) {
    const stored = parseDeviceIds(localStorage.getItem(DEVICE_IDS_KEY))
    const existing = stored[instanceId]
    if (existing) return existing
    const deviceId = legacyDeviceId !== undefined && isServerInstanceId(legacyDeviceId) ? legacyDeviceId : crypto.randomUUID()
    localStorage.setItem(DEVICE_IDS_KEY, JSON.stringify({ ...stored, [instanceId]: deviceId }))
    return deviceId
  }
  const store = await Store.load('store.json')
  const stored = parseDeviceIds(await store.get<string | Record<string, string>>(DEVICE_IDS_KEY))
  const existing = stored[instanceId]
  if (existing) return existing
  const deviceId = legacyDeviceId !== undefined && isServerInstanceId(legacyDeviceId) ? legacyDeviceId : crypto.randomUUID()
  await store.set(DEVICE_IDS_KEY, { ...stored, [instanceId]: deviceId })
  await store.save()
  return deviceId
}

function parseDeviceIds(value: string | Record<string, string> | null | undefined): Record<string, string> {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([instanceId, deviceId]) => (
      isServerInstanceId(instanceId) && typeof deviceId === 'string' && isServerInstanceId(deviceId)
    )))
  } catch {
    return {}
  }
}

function isServerInstanceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isBase64UrlSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

function pendingOnboardingSecretKey(instanceId: string, accountId: string, deviceId: string): string {
  return `notegen-server:onboarding:v1:${instanceId}:${accountId}:${deviceId}`
}

function mobileSessionKey(instanceId: string): string {
  return `notegen-server:refresh:v1:${instanceId}`
}

function isRefreshToken(value: string): boolean {
  return value.length >= 16 && value.length <= 8_192 && !/[\u0000-\u001f\u007f\s]/.test(value)
}

function mobileSecureStorage(): { setCommand: string, getCommand: string, deleteCommand: string } | null {
  if (!isTauriRuntime()) return null
  try {
    const current = platform()
    if (current === 'android') return {
      setCommand: 'set_android_secure_value', getCommand: 'get_android_secure_value', deleteCommand: 'delete_android_secure_value',
    }
    if (current === 'ios') return {
      setCommand: 'set_ios_secure_value', getCommand: 'get_ios_secure_value', deleteCommand: 'delete_ios_secure_value',
    }
  } catch {
    // Secure storage is optional. Never fall back to Store/localStorage.
  }
  return null
}

function parsePendingOnboardingSecret(raw: string | null): PendingOnboardingSecret | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Partial<PendingOnboardingSecret>
    if (record.version !== 1 || !isServerInstanceId(record.instanceId ?? '') || !isServerInstanceId(record.accountId ?? '')
      || !isServerInstanceId(record.deviceId ?? '') || !isServerInstanceId(record.workspaceId ?? '')
      || typeof record.creationIdempotencyKey !== 'string' || !isBase64UrlSecret(record.recoveryKey ?? '')
      || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt ?? 0) <= Date.now()) return null
    return record as PendingOnboardingSecret
  } catch {
    return null
  }
}

function parseMobileServerRefreshCredential(raw: string | null): MobileServerRefreshCredential | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const credential = value as Partial<MobileServerRefreshCredential>
    if (credential.version !== 1 || !isServerInstanceId(credential.instanceId ?? '')
      || !isServerInstanceId(credential.accountId ?? '') || !isServerInstanceId(credential.deviceId ?? '')
      || !isRefreshToken(credential.refreshToken ?? '')
      || (credential.refreshRequestId !== undefined && !isServerInstanceId(credential.refreshRequestId))) return null
    return credential as MobileServerRefreshCredential
  } catch {
    return null
  }
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

export async function discoverServer(baseUrl: string): Promise<ResolvedServerCapabilities> {
  const normalized = normalizeServerOrigin(baseUrl)
  // Discover policy before readiness so UI can present the actual account
  // methods and preserve a useful diagnostic if the instance is gated.
  const capabilities = resolveServerCapabilities(await serverRequest<ServerCapabilities>(
    normalized, '/v1/capabilities', { timeoutMs: 5_000 },
  ))
  if (capabilities.service !== 'note-gen-server') throw new Error('The address is not a NoteGen Sync Server')
  if (capabilities.protocol.minimum > 1 || capabilities.protocol.maximum < 1) {
    throw new Error('The server protocol is incompatible with this NoteGen version')
  }
  if (capabilities.features?.assetObjects !== true) {
    throw new Error('服务器缺少附件资源对象能力，请先升级 NoteGen Sync Server')
  }
  try {
    const ready = await serverRequest<{ status: string }>(normalized, '/health/ready', { timeoutMs: 5_000 })
    return { ...capabilities, readiness: ready.status === 'ok' ? 'ready' : 'unavailable' }
  } catch {
    // Readiness is an operational signal, not a discovery failure. Keep the
    // authenticated UI able to explain the instance and retry later.
    return { ...capabilities, readiness: 'unavailable' }
  }
}

export async function authenticateServer(input: {
  baseUrl: string
  action: 'login' | 'register'
  login: string
  password: string
  totpCode?: string
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
      ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
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
  refreshRequestId?: string
}): Promise<ServerSession> {
  return await serverRequest(normalizeServerOrigin(input.baseUrl), '/v1/auth/refresh', {
    method: 'POST',
    timeoutMs: 8_000,
    body: { refreshToken: input.refreshToken, deviceId: input.deviceId, ...(input.refreshRequestId === undefined ? {} : { refreshRequestId: input.refreshRequestId }) },
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

/** Returns null for pre-account-service servers, preserving the legacy path. */
export async function getServerAccountContext(baseUrl: string, accessToken: string): Promise<ServerAccountContext | null> {
  try {
    return await serverRequest<ServerAccountContext>(normalizeServerOrigin(baseUrl), '/v1/account/context', { accessToken, timeoutMs: 8_000 })
  } catch (error) {
    if (error instanceof NoteGenServerRequestError && error.status === 404) return null
    throw error
  }
}

export async function listServerWorkspaces(baseUrl: string, accessToken: string): Promise<ServerWorkspace[]> {
  return await serverRequest(normalizeServerOrigin(baseUrl), '/v1/workspaces', { accessToken, timeoutMs: 8_000 })
}

export async function createServerWorkspace(input: {
  baseUrl: string
  accessToken: string
  name: string
  syncPassphrase: string
  /** Persisted by the foreground onboarding journal before any network request. */
  creationIdempotencyKey?: string
}): Promise<{ workspace: { id: string, created: boolean }, workspaceKey: CryptoKey, workspaceKeys: ReadonlyMap<number, CryptoKey>, recoveryKey: string }> {
  const workspaceKeyBytes = randomBytes(32)
  const workspaceKey = await importAesKey(workspaceKeyBytes)
  const passphraseSalt = randomBytes(16)
  const passphraseKey = await deriveArgon2idKey(input.syncPassphrase, passphraseSalt, {
    memorySize: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
  })
  const recoveryKeyBytes = randomBytes(32)
  const recoveryKey = await importAesKey(recoveryKeyBytes)
  const nameCiphertext = await encryptText(workspaceKey, input.name)

  const workspace = await serverRequest<{ id: string, created: boolean }>(normalizeServerOrigin(input.baseUrl), '/v1/workspaces', {
    method: 'POST',
    expectedStatus: [200, 201],
    accessToken: input.accessToken,
    ...(input.creationIdempotencyKey === undefined ? {} : { headers: { 'idempotency-key': input.creationIdempotencyKey } }),
    body: {
      nameCiphertext,
      keyVersion: 1,
      envelopes: [
        {
          type: 'passphrase',
          recipientId: null,
          wrappedKey: await encryptBytes(passphraseKey, workspaceKeyBytes),
          kdfSalt: toBase64Url(passphraseSalt),
          kdfParams: {
            memorySize: ARGON2_MEMORY_KIB,
            iterations: ARGON2_ITERATIONS,
            parallelism: ARGON2_PARALLELISM,
            hashBits: 256,
          },
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

/**
 * Recovers the server-side result of a persisted foreground E2EE creation
 * attempt. The key is account-scoped; callers must not use this as discovery.
 */
export async function findServerWorkspaceCreation(input: {
  baseUrl: string
  accessToken: string
  creationIdempotencyKey: string
}): Promise<{ id: string, createdAt: string } | null> {
  try {
    return await serverRequest<{ id: string, createdAt: string }>(
      normalizeServerOrigin(input.baseUrl),
      `/v1/workspace-creation-requests/${encodeURIComponent(input.creationIdempotencyKey)}`,
      { accessToken: input.accessToken, timeoutMs: 8_000 },
    )
  } catch (error) {
    if (error instanceof NoteGenServerRequestError && error.status === 404) return null
    throw error
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
  const passphraseKey = await deriveArgon2idKey(input.syncPassphrase, passphraseSalt, {
    memorySize: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
  })
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
            kdfParams: {
              memorySize: ARGON2_MEMORY_KIB,
              iterations: ARGON2_ITERATIONS,
              parallelism: ARGON2_PARALLELISM,
              hashBits: 256,
            },
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

/**
 * Replaces exactly one active recovery envelope without exposing the workspace
 * key to the server. Callers persist the idempotency key before the request.
 */
export async function replaceServerWorkspaceRecoveryKey(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  keyVersion: number
  workspaceKey: CryptoKey
  idempotencyKey: string
  /** Reuse the original candidate for a persisted retry; never store it in the ordinary profile. */
  recoveryKey?: string
}): Promise<{ recoveryKey: string, created: boolean }> {
  const workspaceKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', input.workspaceKey))
  const recoveryKeyBytes = input.recoveryKey === undefined ? randomBytes(32) : fromBase64Url(input.recoveryKey)
  if (recoveryKeyBytes.byteLength !== 32) throw new Error('The recovery key is invalid')
  const recoveryKeyValue = toBase64Url(recoveryKeyBytes)
  if (input.recoveryKey !== undefined && input.recoveryKey !== recoveryKeyValue) throw new Error('The recovery key is invalid')
  const recoveryKey = await importAesKey(recoveryKeyBytes)
  const response = await serverRequest<{ id: string, status: 'active', created: boolean }>(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/keys/${input.keyVersion}/recovery-envelope`,
    {
      method: 'PUT', accessToken: input.accessToken, timeoutMs: 8_000,
      headers: { 'idempotency-key': input.idempotencyKey },
      body: {
        type: 'recovery', recipientId: null,
        wrappedKey: await encryptBytes(recoveryKey, workspaceKeyBytes),
        kdfSalt: null, kdfParams: null,
      },
    },
  )
  return { recoveryKey: recoveryKeyValue, created: response.created }
}

/** Generates a recovery key only for foreground display or secure storage. */
export function createServerWorkspaceRecoveryKey(): string {
  return toBase64Url(randomBytes(32))
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
  const memorySize = envelope.kdfParams?.memorySize
  const parallelism = envelope.kdfParams?.parallelism
  if (memorySize && parallelism) {
    return await deriveArgon2idKey(syncPassphrase, fromBase64Url(envelope.kdfSalt), {
      memorySize,
      iterations,
      parallelism,
    })
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

export interface EncryptedServerBlob {
  blobId: string
  ciphertextHash: string
  ciphertext?: Uint8Array
  ciphertextSize?: number
  readRange?: (start: number, endExclusive: number) => Promise<Uint8Array>
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
  if (ciphertext.length >= 24
    && ciphertext[0] === 0x4e && ciphertext[1] === 0x47
    && ciphertext[2] === 0x42 && ciphertext[3] === 0x32) {
    const header = ciphertext.subarray(0, 24)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const chunkBytes = view.getUint32(4)
    const plaintextSize = Number(view.getBigUint64(8))
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0
      || chunkBytes < 64 * 1024 || chunkBytes > 16 * 1024 * 1024) {
      throw new Error('服务器 Blob 分块加密头无效')
    }
    const chunkCount = Math.ceil(plaintextSize / chunkBytes)
    const expectedSize = 24 + plaintextSize + (chunkCount * 16)
    if (ciphertext.byteLength !== expectedSize) throw new Error('服务器 Blob 分块密文长度无效')
    const plaintext = new Uint8Array(plaintextSize)
    let ciphertextOffset = 24
    let plaintextOffset = 0
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const plainLength = Math.min(chunkBytes, plaintextSize - plaintextOffset)
      const encryptedLength = plainLength + 16
      const nonce = new Uint8Array(12)
      nonce.set(header.subarray(16, 24), 0)
      new DataView(nonce.buffer).setUint32(8, chunkIndex)
      const chunkNumber = new Uint8Array(4)
      new DataView(chunkNumber.buffer).setUint32(0, chunkIndex)
      const additionalData = joinByteArrays(
        new TextEncoder().encode('notegen-server-blob-v2'), header, chunkNumber,
      )
      const decrypted = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData }, workspaceKey,
        ciphertext.subarray(ciphertextOffset, ciphertextOffset + encryptedLength),
      ))
      if (decrypted.byteLength !== plainLength) throw new Error('服务器 Blob 分块解密长度无效')
      plaintext.set(decrypted, plaintextOffset)
      ciphertextOffset += encryptedLength
      plaintextOffset += plainLength
    }
    return plaintext
  }
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

function joinByteArrays(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export async function uploadServerBlob(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  expectedSyncEpoch?: string
  blob: EncryptedServerBlob
  onProgress?: (progress: { blobId: string, completedBytes: number, totalBytes: number }) => void | Promise<void>
}): Promise<void> {
  const ciphertextSize = input.blob.ciphertext?.byteLength ?? input.blob.ciphertextSize
  if (!ciphertextSize || ciphertextSize <= 0) throw new Error('Blob 密文长度无效')
  const readRange = input.blob.readRange ?? (async (start: number, endExclusive: number) => {
    if (!input.blob.ciphertext) throw new Error('Blob 密文读取器不可用')
    return input.blob.ciphertext.slice(start, endExclusive)
  })
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
      expectedSize: String(ciphertextSize),
      ciphertextHash: input.blob.ciphertextHash,
      ...(input.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: input.expectedSyncEpoch }),
    },
  })
  if (upload.alreadyExists) {
    await input.onProgress?.({
      blobId: input.blob.blobId,
      completedBytes: ciphertextSize,
      totalBytes: ciphertextSize,
    })
    return
  }
  if (!upload.uploadId || upload.partBytes <= 0) throw new Error('服务器返回了无效的 Blob 上传会话')
  const uploadedParts = new Set(upload.uploadedParts.map(part => part.partNumber))
  const partCount = Math.ceil(ciphertextSize / upload.partBytes)
  const partSize = (partNumber: number) => Math.max(0, Math.min(
    upload.partBytes,
    ciphertextSize - ((partNumber - 1) * upload.partBytes),
  ))
  let completedBytes = Array.from(uploadedParts).reduce(
    (total, partNumber) => total + partSize(partNumber), 0,
  )
  await input.onProgress?.({
    blobId: input.blob.blobId,
    completedBytes,
    totalBytes: ciphertextSize,
  })
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (uploadedParts.has(partNumber)) continue
    const start = (partNumber - 1) * upload.partBytes
    const end = Math.min(ciphertextSize, start + upload.partBytes)
    await binaryServerRequest(
      normalizeServerOrigin(input.baseUrl),
      `/v1/workspaces/${input.workspaceId}/blobs/uploads/${upload.uploadId}/parts/${partNumber}`,
      {
        method: 'PUT',
        accessToken: input.accessToken,
        body: await readRange(start, end),
      },
    )
    completedBytes += end - start
    await input.onProgress?.({
      blobId: input.blob.blobId,
      completedBytes,
      totalBytes: ciphertextSize,
    })
  }
  await serverRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/blobs/uploads/${upload.uploadId}/complete`,
    { method: 'POST', accessToken: input.accessToken, body: input.expectedSyncEpoch === undefined
      ? undefined : { expectedSyncEpoch: input.expectedSyncEpoch } },
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

export async function getServerBlobMetadata(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  blobId: string
}): Promise<{ size: number, ciphertextHash: string }> {
  const response = await binaryServerResponse(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/blobs/${input.blobId}`,
    { method: 'HEAD', accessToken: input.accessToken },
  )
  const size = Number(response.headers.get('content-length'))
  const ciphertextHash = response.headers.get('x-ciphertext-hash') || ''
  if (!Number.isSafeInteger(size) || size <= 0 || ciphertextHash !== input.blobId) {
    throw new Error('服务器返回了无效的 Blob 元数据')
  }
  return { size, ciphertextHash }
}

export async function downloadServerBlobRange(input: {
  baseUrl: string
  accessToken: string
  workspaceId: string
  blobId: string
  start: number
  end: number
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end)
    || input.start < 0 || input.end < input.start) {
    throw new Error('Blob 下载区间无效')
  }
  const response = await binaryServerRequest(
    normalizeServerOrigin(input.baseUrl),
    `/v1/workspaces/${input.workspaceId}/blobs/${input.blobId}`,
    {
      accessToken: input.accessToken,
      headers: { range: `bytes=${input.start}-${input.end}` },
    },
  )
  if (response.byteLength !== input.end - input.start + 1) {
    throw new Error('服务器返回的 Blob 分片长度不正确')
  }
  return response
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

export class NoteGenServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'NoteGenServerRequestError'
  }
}

/** Only explicit server-side credential revocation may erase local sync state. */
export function isTerminalServerSessionError(error: unknown): boolean {
  return error instanceof NoteGenServerRequestError && [
    'refresh_token_invalid', 'refresh_token_revoked', 'refresh_token_reused',
    'device_revoked', 'credential_epoch_invalid', 'instance_auth_epoch_invalid', 'account_deletion_completed',
  ].includes(error.code ?? '')
}

/**
 * These responses require an account, policy, operator, or maintenance action.
 * They must retain local outbox state but may not drive an automatic retry loop.
 */
export function isSyncActionRequiredServerError(error: unknown): error is NoteGenServerRequestError {
  return error instanceof NoteGenServerRequestError && [
    'email_verification_required', 'policy_acceptance_required', 'policy_reacceptance_required',
    'risk_challenge_required', 'risk_temporarily_locked', 'risk_review_required', 'risk_denied',
    'quota_exceeded', 'device_limit_exceeded', 'workspace_limit_exceeded',
    'account_read_only', 'credential_review_required', 'server_maintenance', 'cursor_expired',
    'sync_epoch_changed', 'instance_auth_epoch_invalid',
  ].includes(error.code ?? '')
}

export async function serverRequest<T>(
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
    let details: Record<string, unknown> | undefined
    try {
      const body = JSON.parse(text) as {
        message?: string
        code?: string
        retryable?: boolean
        details?: Record<string, unknown>
      }
      code = body.code
      retryable = body.retryable ?? false
      message = body.message ? `${body.message}${body.code ? ` (${body.code})` : ''}` : message
      details = body.details
    } catch {
      // Keep the raw response.
    }
    throw new NoteGenServerRequestError(
      `${message} [${path}]`, response.status, code, retryable,
      details, parseRetryAfter(response.headers.get('retry-after'), details?.retryAfterSeconds),
    )
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new NoteGenServerRequestError(
      `同步服务器返回了不完整的数据（${path}，HTTP ${response.status}，${text.length} 字节）`,
      response.status,
      'invalid_json_response',
      true,
    )
  }
}

function parseRetryAfter(header: string | null, detailValue?: unknown): number | undefined {
  const fromDetails = typeof detailValue === 'number' && Number.isFinite(detailValue) ? detailValue : undefined
  const value = header?.trim()
  if (!value) return fromDetails
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 24 * 60 * 60)
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.min(Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000)), 24 * 60 * 60)
  return fromDetails
}

async function binaryServerRequest(
  baseUrl: string,
  path: string,
  options: { method?: string, accessToken: string, body?: Uint8Array, headers?: Record<string, string> },
): Promise<Uint8Array> {
  const response = await binaryServerResponse(baseUrl, path, options)
  return new Uint8Array(await response.arrayBuffer())
}

async function binaryServerResponse(
  baseUrl: string,
  path: string,
  options: { method?: string, accessToken: string, body?: Uint8Array, headers?: Record<string, string> },
): Promise<Response> {
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
        ...options.headers,
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
  return response
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

async function deriveArgon2idKey(
  passphrase: string,
  salt: Uint8Array,
  params: { memorySize: number, iterations: number, parallelism: number },
): Promise<CryptoKey> {
  const { argon2id } = await import('hash-wasm')
  const bytes = await argon2id({
    password: passphrase,
    salt,
    memorySize: params.memorySize,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })
  return await importAesKey(bytes)
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

async function encryptText(key: CryptoKey, value: string): Promise<string> {
  return await encryptBytes(key, new TextEncoder().encode(value))
}

async function encryptBytes(key: CryptoKey, value: Uint8Array): Promise<string> {
  const iv = randomBytes(12)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, value))
  const result = new Uint8Array(iv.length + encrypted.length)
  result.set(iv)
  result.set(encrypted, iv.length)
  return toBase64Url(result)
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
