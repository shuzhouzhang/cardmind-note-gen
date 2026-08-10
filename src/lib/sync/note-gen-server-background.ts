import { appDataDir, join } from '@tauri-apps/api/path'
import { watch } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'

import {
  initNoteGenServerSyncDb,
  retryBlockedNoteGenServerOutbox,
} from '@/db/note-gen-server-sync'
import {
  initNoteGenServerSyncV2Db,
  getSyncV2HealthSnapshot,
  listSyncV2ProblemDetails,
  retrySyncV2Problems,
  type SyncV2ProblemDetail,
} from '@/db/note-gen-server-sync-index'
import emitter from '@/lib/emitter'
import { getWorkspacePath } from '@/lib/workspace'
import {
  clearServerSession,
  discoverServer,
  getOrCreateManagedServerWorkspace,
  getNoteGenServerSyncScopeId,
  loadServerProfile,
  loadServerSession,
  NoteGenServerRequestError,
  refreshServerSession,
  saveServerProfile,
  saveServerSession,
  unlockServerWorkspace,
  type NoteGenServerProfile,
  type ServerSession,
} from './note-gen-server'
import {
  runNoteGenServerSyncV2Cycle,
  resetNoteGenServerSyncV2Reconciliation,
  SyncV2KeyMissingError,
  type NoteGenServerSyncV2CycleResult,
} from './note-gen-server-sync-runtime'
import {
  queueCurrentNoteGenServerMarkdownWorkspace,
  queueNoteGenServerMarkdownChange,
} from './note-gen-server-outbox'

interface RuntimeState {
  profile: NoteGenServerProfile
  session: ServerSession
  accessTokenExpiresAt: number
  workspaceKey?: CryptoKey
  workspaceKeys?: ReadonlyMap<number, CryptoKey>
  keyVersion?: number
  syncScopeId?: string
}

export interface NoteGenServerBackgroundStatus {
  phase: 'idle' | 'saving' | 'pending' | 'syncing' | 'synced' | 'offline'
    | 'needs-attention' | 'paused' | 'workspace-mismatch' | 'error'
  result?: NoteGenServerSyncV2CycleResult
  problems?: SyncV2ProblemDetail[]
  error?: string
  updatedAt: number
}

type SessionListener = (session: ServerSession | null) => void
type StatusListener = (status: NoteGenServerBackgroundStatus) => void

export interface NoteGenServerPresence {
  workspaceId: string
  documentId: string
  deviceId: string
  label: string
  anchor: number
  head: number
}

type PresenceListener = (presence: NoteGenServerPresence | null, deviceId: string) => void

export interface NoteGenServerRealtimeDocumentUpdate {
  workspaceId: string
  documentId: string
  objectId: string
  kind: string
  updateId: string
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
}

type DocumentUpdateListener = (update: NoteGenServerRealtimeDocumentUpdate) => void
type DocumentSyncRequestListener = (workspaceId: string, documentId: string) => void

let state: RuntimeState | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<void> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncRunning = false
let syncRequested = false
let syncRequestedShowProgress = false
let syncStartsInFlight = 0
let syncIdleWaiters: Array<() => void> = []
let syncDelayMs = 60_000
let runtimeGeneration = 0
let initialization: Promise<void> | null = null
let unwatchWorkspace: (() => void) | null = null
let eventSocket: WebSocket | null = null
let eventSocketAuthenticated = false
let localPresence: Omit<NoteGenServerPresence, 'deviceId'> | null = null
const remotePresenceDeviceIds = new Set<string>()
const presenceListeners = new Set<PresenceListener>()
const documentUpdateListeners = new Set<DocumentUpdateListener>()
const documentSyncRequestListeners = new Set<DocumentSyncRequestListener>()
const realtimeDocumentSubscriptions = new Map<string, {
  workspaceId: string
  documentId: string
  retainCount: number
}>()
let socketGeneration = 0
let socketReconnectTimer: ReturnType<typeof setTimeout> | null = null
let socketReconnectDelayMs = 1_000
// WebSocket events trigger synchronization immediately. This timer is only a
// one-minute safety net for missed events, suspended apps, or broken sockets.
// Text edits use the WebSocket room directly; the existing object sync queue
// remains the durable path for these non-text entities.
const normalSyncDelayMs = 60_000
const maximumSyncDelayMs = 5 * 60_000
const maximumSocketReconnectDelayMs = 60_000
const sessionListeners = new Set<SessionListener>()
const statusListeners = new Set<StatusListener>()
let currentStatus: NoteGenServerBackgroundStatus = { phase: 'idle', updatedAt: Date.now() }
let primaryEnabled = false
let articleSavedListenerRegistered = false
let lifecycleListenersRegistered = false
let resumeInFlight: Promise<void> | null = null

export function isNoteGenServerPrimaryEnabled(): boolean {
  return primaryEnabled
}

export async function initNoteGenServerBackgroundRuntime(): Promise<void> {
  ensureArticleSavedListener()
  ensureLifecycleListeners()
  if (initialization) return await initialization
  const currentInitialization = initializeRuntime()
  initialization = currentInitialization
  try {
    await currentInitialization
  } catch (error) {
    if (initialization === currentInitialization) initialization = null
    throw error
  }
}

async function initializeRuntime(): Promise<void> {
  await initNoteGenServerSyncDb()
  await initNoteGenServerSyncV2Db()
  const settings = await Store.load('store.json')
  primaryEnabled = await settings.get<string>('primaryBackupMethod') === 'noteGenServer'
  const storedProfile = await loadServerProfile()
  if (!storedProfile?.enabled) return
  const localWorkspaceKey = await getNoteGenServerLocalWorkspaceKey()
  const profile = storedProfile.localWorkspaceKey
    ? storedProfile
    : { ...storedProfile, localWorkspaceKey }
  if (!storedProfile.localWorkspaceKey) await saveServerProfile(profile)
  const stored = await loadServerSession(profile.instanceId)
  if (!stored) return
  try {
    const capabilities = await discoverServer(profile.baseUrl)
    if (capabilities.instanceId !== profile.instanceId) throw new Error('Server instance identity changed')
    const session = await refreshServerSession({
      baseUrl: profile.baseUrl,
      refreshToken: stored.refreshToken,
      deviceId: profile.deviceId,
    })
    if (profile.encryptionMode !== 'e2ee'
      && capabilities.features?.managedDefaultWorkspace === true) {
      const provisioned = await getOrCreateManagedServerWorkspace({
        baseUrl: profile.baseUrl,
        accessToken: session.accessToken,
      })
      const managedProfile: NoteGenServerProfile = {
        ...profile,
        workspaceId: provisioned.workspace.id,
        encryptionMode: 'managed',
      }
      await configureNoteGenServerBackgroundSession(managedProfile, session)
      if (primaryEnabled && provisioned.unlocked
        && doesProfileMatchLocalWorkspace(managedProfile, localWorkspaceKey)) {
        unlockNoteGenServerBackgroundWorkspace({
          workspaceKey: provisioned.unlocked.key,
          workspaceKeys: provisioned.unlocked.keys,
          keyVersion: provisioned.unlocked.keyVersion,
        })
      }
      return
    }
    await configureNoteGenServerBackgroundSession(profile, session)
    if (primaryEnabled && profile.workspaceId && doesProfileMatchLocalWorkspace(profile, localWorkspaceKey)) {
      try {
        const unlocked = await unlockServerWorkspace({
          baseUrl: profile.baseUrl,
          accessToken: session.accessToken,
          workspaceId: profile.workspaceId,
        })
        unlockNoteGenServerBackgroundWorkspace({
          workspaceKey: unlocked.key,
          workspaceKeys: unlocked.keys,
          keyVersion: unlocked.keyVersion,
        })
      } catch {
        // Advanced end-to-end encrypted workspaces still require an explicit local unlock.
      }
    }
  } catch (error) {
    if (error instanceof NoteGenServerRequestError
      && (error.status === 401 || error.status === 403 || error.status === 404)) {
      await clearServerSession()
      notifySession(null)
      notifyStatus({ phase: 'paused', error: errorMessage(error), updatedAt: Date.now() })
      return
    }
    if (/instance identity changed/i.test(errorMessage(error))) {
      notifyStatus({ phase: 'paused', error: errorMessage(error), updatedAt: Date.now() })
      return
    }
    notifyStatus({ phase: 'offline', error: errorMessage(error), updatedAt: Date.now() })
    throw error
  }
}

export async function configureNoteGenServerBackgroundSession(
  profile: NoteGenServerProfile,
  session: ServerSession,
): Promise<void> {
  ensureArticleSavedListener()
  await initNoteGenServerSyncDb()
  await initNoteGenServerSyncV2Db()
  const localWorkspaceKey = await getNoteGenServerLocalWorkspaceKey()
  const profileMatchesLocalWorkspace = !profile.localWorkspaceKey
    || profile.localWorkspaceKey === localWorkspaceKey
  const boundProfile = profile.localWorkspaceKey
    ? profile
    : { ...profile, localWorkspaceKey }
  const syncScopeId = boundProfile.workspaceId
    ? await getNoteGenServerSyncScopeId(boundProfile)
    : undefined
  const preserveUnlockedWorkspace = state !== null
    && state.profile.instanceId === boundProfile.instanceId
    && state.session.accountId === session.accountId
    && state.profile.workspaceId === boundProfile.workspaceId
    && state.profile.localWorkspaceKey === boundProfile.localWorkspaceKey
  if (!preserveUnlockedWorkspace) clearUnlockedWorkspaceRuntime()
  state = {
    profile: boundProfile,
    session,
    accessTokenExpiresAt: Date.now() + session.accessTokenExpiresIn * 1_000,
    ...(syncScopeId ? { syncScopeId } : {}),
    ...(preserveUnlockedWorkspace && state?.workspaceKey ? { workspaceKey: state.workspaceKey } : {}),
    ...(preserveUnlockedWorkspace && state?.workspaceKeys ? { workspaceKeys: state.workspaceKeys } : {}),
    ...(preserveUnlockedWorkspace && state?.keyVersion ? { keyVersion: state.keyVersion } : {}),
  }
  await saveServerProfile(boundProfile)
  await saveServerSession(boundProfile.instanceId, session)
  if (!primaryEnabled) {
    unwatchWorkspace?.()
    unwatchWorkspace = null
    notifyStatus({ phase: 'idle', updatedAt: Date.now() })
  } else if (profileMatchesLocalWorkspace) {
    await startWorkspaceWatcher().catch(error => {
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    })
  } else {
    unwatchWorkspace?.()
    unwatchWorkspace = null
    notifyStatus({ phase: 'workspace-mismatch', updatedAt: Date.now() })
  }
  scheduleRefresh()
  notifySession(session)
}

export function getNoteGenServerBackgroundConnection(): {
  profile: NoteGenServerProfile
  session: ServerSession
} | null {
  return state ? { profile: state.profile, session: state.session } : null
}

export function publishNoteGenServerPresence(
  presence: Omit<NoteGenServerPresence, 'deviceId'> | null,
): void {
  localPresence = presence
  if (!eventSocketAuthenticated || eventSocket?.readyState !== WebSocket.OPEN) return
  eventSocket.send(JSON.stringify(presence
    ? { type: 'presence.update', ...presence }
    : { type: 'presence.clear' }))
}

export function subscribeNoteGenServerPresence(listener: PresenceListener): () => void {
  presenceListeners.add(listener)
  return () => presenceListeners.delete(listener)
}

export function publishNoteGenServerDocumentUpdate(
  update: NoteGenServerRealtimeDocumentUpdate,
): void {
  if (!eventSocketAuthenticated || eventSocket?.readyState !== WebSocket.OPEN) return
  // Large recovery snapshots remain on the durable HTTP path. Keeping room
  // messages below the WebSocket frame cap prevents one reconnect from
  // dropping presence and subsequent incremental updates for every editor.
  if (update.ciphertext.length > 3 * 1024 * 1024) return
  eventSocket.send(JSON.stringify({ type: 'document.update', ...update }))
}

export function subscribeNoteGenServerDocumentUpdates(
  listener: DocumentUpdateListener,
): () => void {
  documentUpdateListeners.add(listener)
  return () => documentUpdateListeners.delete(listener)
}

export function subscribeNoteGenServerDocumentSyncRequests(
  listener: DocumentSyncRequestListener,
): () => void {
  documentSyncRequestListeners.add(listener)
  return () => documentSyncRequestListeners.delete(listener)
}

export function retainNoteGenServerRealtimeDocument(
  workspaceId: string,
  documentId: string,
): () => void {
  const key = `${workspaceId}\0${documentId}`
  const existing = realtimeDocumentSubscriptions.get(key)
  if (existing) existing.retainCount += 1
  else realtimeDocumentSubscriptions.set(key, { workspaceId, documentId, retainCount: 1 })
  sendRealtimeDocumentSubscription('document.subscribe', workspaceId, documentId)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = realtimeDocumentSubscriptions.get(key)
    if (!current) return
    current.retainCount -= 1
    if (current.retainCount > 0) return
    realtimeDocumentSubscriptions.delete(key)
    sendRealtimeDocumentSubscription('document.unsubscribe', workspaceId, documentId)
  }
}

function sendRealtimeDocumentSubscription(
  type: 'document.subscribe' | 'document.unsubscribe',
  workspaceId: string,
  documentId: string,
): void {
  if (!eventSocketAuthenticated || eventSocket?.readyState !== WebSocket.OPEN) return
  eventSocket.send(JSON.stringify({ type, workspaceId, documentId }))
}

export function getNoteGenServerBackgroundWorkspaceKey(): CryptoKey | null {
  return state?.workspaceKey ?? null
}

export function getNoteGenServerBackgroundV2Context(): {
  workspaceId: string
  syncScopeId: string
  workspaceKey: CryptoKey
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  keyVersion: number
} | null {
  if (!state?.profile.workspaceId || !state.syncScopeId || !state.workspaceKey || !state.workspaceKeys || !state.keyVersion) return null
  return {
    workspaceId: state.profile.workspaceId, syncScopeId: state.syncScopeId,
    workspaceKey: state.workspaceKey, workspaceKeys: state.workspaceKeys, keyVersion: state.keyVersion,
  }
}

export function getNoteGenServerBackgroundReadiness(): {
  primary: boolean
  connected: boolean
  unlocked: boolean
} {
  return {
    primary: primaryEnabled,
    connected: state !== null,
    unlocked: Boolean(
      state?.profile.workspaceId
      && state.syncScopeId
      && state.workspaceKey
      && state.workspaceKeys
      && state.keyVersion,
    ),
  }
}

export function unlockNoteGenServerBackgroundWorkspace(input: {
  workspaceKey: CryptoKey
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  keyVersion: number
}): void {
  if (!state?.profile.workspaceId || !state.syncScopeId) return
  state = {
    ...state,
    workspaceKey: input.workspaceKey,
    workspaceKeys: input.workspaceKeys,
    keyVersion: input.keyVersion,
  }
  if (!primaryEnabled) {
    notifyStatus({ phase: 'idle', updatedAt: Date.now() })
    return
  }
  void startWorkspaceWatcher().catch(error => {
    notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
  })
  startSyncLoop()
  connectEventSocket()
  void import('./note-gen-server-domains').then(module => (
    state?.profile.workspaceId ? module.startNoteGenServerPreferencesCollaboration(state.profile.workspaceId) : undefined
  ))
  void triggerNoteGenServerBackgroundSync()
}

/**
 * Wait until the current sync request (including a coalesced follow-up request)
 * has settled. This is used after first pairing/unlock so the UI cannot report
 * a connected account before the initial remote pull has completed.
 */
export async function syncNoteGenServerNow(): Promise<void> {
  if (!primaryEnabled) return
  await triggerNoteGenServerBackgroundSync()
  while (syncRunning || syncRequested || syncStartsInFlight > 0) {
    if (syncRunning) await waitForCurrentSyncCycle()
    else await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

export function lockNoteGenServerBackgroundWorkspace(): void {
  if (state) {
    state = {
      profile: state.profile,
      session: state.session,
      accessTokenExpiresAt: state.accessTokenExpiresAt,
      ...(state.syncScopeId ? { syncScopeId: state.syncScopeId } : {}),
    }
  }
  clearUnlockedWorkspaceRuntime()
  void import('./note-gen-server-collab').then(module => (
    module.destroyNoteGenServerCollaborationSessions()
  ))
  unwatchWorkspace?.()
  unwatchWorkspace = null
  notifyStatus({ phase: 'idle', updatedAt: Date.now() })
}

export async function triggerNoteGenServerBackgroundSync(options: {
  showProgress?: boolean
} = {}): Promise<NoteGenServerSyncV2CycleResult | null> {
  const showProgress = options.showProgress !== false
  if (!primaryEnabled) return null
  if (!state?.profile.workspaceId || !state.syncScopeId || !state.workspaceKey || !state.workspaceKeys || !state.keyVersion) return null
  if (!await activeLocalWorkspaceMatches()) {
    lockNoteGenServerBackgroundWorkspace()
    notifyStatus({ phase: 'workspace-mismatch', updatedAt: Date.now() })
    return null
  }
  if (syncRunning) {
    syncRequested = true
    syncRequestedShowProgress ||= showProgress
    return null
  }
  syncRunning = true
  syncRequested = false
  syncRequestedShowProgress = false
  const generation = runtimeGeneration
  if (showProgress) notifyStatus({ phase: 'syncing', updatedAt: Date.now() })
  try {
    if (Date.now() >= state.accessTokenExpiresAt - 60_000) await refreshSession()
    let result: NoteGenServerSyncV2CycleResult
    try {
      result = await runCurrentSyncCycle()
    } catch (error) {
      if (!(error instanceof NoteGenServerRequestError) || error.status !== 401) throw error
      await refreshSession()
      result = await runCurrentSyncCycle()
    }
    syncDelayMs = normalSyncDelayMs
    if (generation === runtimeGeneration) {
      const hasProblems = result.blockedOutbox > 0 || result.failedInbox > 0 || result.failedTransfers > 0
      const problemScopeId = state?.syncScopeId
      const problems = hasProblems && problemScopeId
        ? await listSyncV2ProblemDetails(problemScopeId).catch(error => {
            console.error('Failed to load sync problem details:', error)
            return []
          })
        : []
      notifyStatus(hasProblems
        ? {
            phase: 'needs-attention',
            result,
            problems,
            error: `有 ${result.blockedOutbox + result.failedInbox + result.failedTransfers} 项同步数据需要处理`,
            updatedAt: Date.now(),
          }
        : result.unresolvedConflicts > 0
          ? { phase: 'needs-attention', result, error: `有 ${result.unresolvedConflicts} 个冲突需要处理`, updatedAt: Date.now() }
          : result.converged
            ? { phase: 'synced', result, updatedAt: Date.now() }
            : { phase: 'pending', result, updatedAt: Date.now() })
    }
    return result
  } catch (error) {
    console.error('NoteGen Server background sync failed:', error)
    if (error instanceof NoteGenServerRequestError && error.status === 401) {
      await clearServerSession()
      stopNoteGenServerBackgroundRuntime()
      notifyStatus({ phase: 'paused', error: errorMessage(error), updatedAt: Date.now() })
      return null
    }
    if (error instanceof SyncV2KeyMissingError) {
      notifyStatus({ phase: 'paused', error: error.message, updatedAt: Date.now() })
      return null
    }
    if (error instanceof NoteGenServerRequestError
      && error.code === 'protocol_incompatible') {
      notifyStatus({ phase: 'paused', error: error.message, updatedAt: Date.now() })
      return null
    }
    const transient = isTransientSyncError(error)
    syncDelayMs = transient
      ? Math.min(Math.max(syncDelayMs, normalSyncDelayMs) * 2, maximumSyncDelayMs)
      : normalSyncDelayMs
    if (generation === runtimeGeneration) {
      notifyStatus({
        phase: transient ? 'offline' : 'error',
        error: errorMessage(error),
        updatedAt: Date.now(),
      })
    }
    return null
  } finally {
    syncRunning = false
    const waiters = syncIdleWaiters
    syncIdleWaiters = []
    waiters.forEach(resolve => resolve())
    if (syncRequested) {
      const followUpShowProgress = syncRequestedShowProgress
      syncRequested = false
      syncRequestedShowProgress = false
      syncStartsInFlight += 1
      void triggerNoteGenServerBackgroundSync({ showProgress: followUpShowProgress }).finally(() => {
        syncStartsInFlight = Math.max(0, syncStartsInFlight - 1)
      })
    } else if (generation === runtimeGeneration) {
      scheduleNextSync(syncDelayMs)
    }
  }
}

export async function retryNoteGenServerBackgroundSync(): Promise<NoteGenServerSyncV2CycleResult | null> {
  const syncScopeId = state?.syncScopeId
  if (!syncScopeId) return null
  await waitForCurrentSyncCycle()
  if (state?.syncScopeId !== syncScopeId) return null
  await Promise.all([
    retryBlockedNoteGenServerOutbox(syncScopeId),
    retrySyncV2Problems(syncScopeId),
  ])
  notifyStatus({ phase: 'pending', updatedAt: Date.now() })
  return await triggerNoteGenServerBackgroundSync()
}

export function stopNoteGenServerBackgroundRuntime(): void {
  resetNoteGenServerSyncV2Reconciliation(state?.syncScopeId)
  state = null
  if (refreshTimer) clearTimeout(refreshTimer)
  clearUnlockedWorkspaceRuntime()
  void import('./note-gen-server-collab').then(module => (
    module.destroyNoteGenServerCollaborationSessions()
  ))
  unwatchWorkspace?.()
  refreshTimer = null
  unwatchWorkspace = null
  initialization = null
  notifySession(null)
  notifyStatus({ phase: 'idle', updatedAt: Date.now() })
}

export async function setNoteGenServerPrimaryEnabled(enabled: boolean): Promise<void> {
  ensureArticleSavedListener()
  primaryEnabled = enabled
  clearUnlockedWorkspaceRuntime()
  if (!enabled) {
    await import('./note-gen-server-collab').then(module => (
      module.destroyNoteGenServerCollaborationSessions()
    ))
  }
  unwatchWorkspace?.()
  unwatchWorkspace = null

  if (!enabled) {
    await waitForCurrentSyncCycle()
    resetNoteGenServerSyncV2Reconciliation(state?.syncScopeId)
    notifyStatus({ phase: 'idle', updatedAt: Date.now() })
    return
  }
  if (!state) {
    try {
      await initNoteGenServerBackgroundRuntime()
    } catch (error) {
      notifyStatus({ phase: 'offline', error: errorMessage(error), updatedAt: Date.now() })
      return
    }
    if (!state) {
      notifyStatus({ phase: 'idle', updatedAt: Date.now() })
      return
    }
  }
  if (!await activeLocalWorkspaceMatches()) {
    notifyStatus({ phase: 'workspace-mismatch', updatedAt: Date.now() })
    return
  }

  await startWorkspaceWatcher()
  if (!state.workspaceKey || !state.workspaceKeys || !state.keyVersion || !state.profile.workspaceId) {
    notifyStatus({ phase: 'idle', updatedAt: Date.now() })
    return
  }
  startSyncLoop()
  connectEventSocket()
  void triggerNoteGenServerBackgroundSync()
}

export async function disconnectNoteGenServerBackgroundRuntime(): Promise<{
  profile: NoteGenServerProfile
  session: ServerSession
} | null> {
  if (refreshInFlight) {
    try {
      await refreshInFlight
    } catch {
      // Local disconnect must still complete when refreshing an expired session fails.
    }
  }
  const connection = getNoteGenServerBackgroundConnection()
  stopNoteGenServerBackgroundRuntime()
  return connection
}

function clearUnlockedWorkspaceRuntime(): void {
  void import('./note-gen-server-domains').then(module => module.stopNoteGenServerPreferencesCollaboration())
  runtimeGeneration += 1
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  socketGeneration += 1
  eventSocket?.close()
  eventSocket = null
  eventSocketAuthenticated = false
  localPresence = null
  clearRemotePresence()
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer)
  socketReconnectTimer = null
  syncRequested = false
  syncRequestedShowProgress = false
  syncDelayMs = normalSyncDelayMs
  socketReconnectDelayMs = 1_000
}

async function waitForCurrentSyncCycle(): Promise<void> {
  if (!syncRunning) return
  await new Promise<void>(resolve => syncIdleWaiters.push(resolve))
}

export function subscribeNoteGenServerSession(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  listener(state?.session ?? null)
  return () => sessionListeners.delete(listener)
}

export function subscribeNoteGenServerBackgroundStatus(listener: StatusListener): () => void {
  statusListeners.add(listener)
  listener(currentStatus)
  return () => statusListeners.delete(listener)
}

async function refreshSession(): Promise<void> {
  if (refreshInFlight) return await refreshInFlight
  refreshInFlight = refreshSessionNow()
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

async function refreshSessionNow(): Promise<void> {
  if (!state) return
  const current = state
  const session = await refreshServerSession({
    baseUrl: current.profile.baseUrl,
    refreshToken: current.session.refreshToken,
    deviceId: current.profile.deviceId,
  })
  if (!state
    || state.profile.instanceId !== current.profile.instanceId
    || state.session.accountId !== current.session.accountId
    || state.profile.deviceId !== current.profile.deviceId) return
  state = {
    ...state,
    session,
    accessTokenExpiresAt: Date.now() + session.accessTokenExpiresIn * 1_000,
  }
  await saveServerSession(state.profile.instanceId, session)
  scheduleRefresh()
  if (state.workspaceKey) connectEventSocket()
  notifySession(session)
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  if (!state) return
  const delay = Math.max(state.accessTokenExpiresAt - Date.now() - 60_000, 1_000)
  refreshTimer = setTimeout(() => {
    void refreshSession().catch(async error => {
      await clearServerSession()
      stopNoteGenServerBackgroundRuntime()
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    })
  }, delay)
}

function startSyncLoop(): void {
  if (!primaryEnabled) return
  syncDelayMs = normalSyncDelayMs
  scheduleNextSync(syncDelayMs)
}

function scheduleNextSync(delay: number): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  if (!primaryEnabled || !state?.profile.workspaceId || !state.syncScopeId || !state.workspaceKey || !state.workspaceKeys || !state.keyVersion) return
  syncTimer = setTimeout(() => {
    syncTimer = null
    // An authenticated event socket is the idle signal. Do not run a full
    // pull/reconciliation cycle every minute when the server has announced no
    // changes; retain the timer only as a fallback for a disconnected socket.
    if (eventSocketAuthenticated) {
      scheduleNextSync(normalSyncDelayMs)
      return
    }
    void triggerNoteGenServerBackgroundSync({ showProgress: false })
  }, delay)
}

async function runCurrentSyncCycle(): Promise<NoteGenServerSyncV2CycleResult> {
  if (!state?.profile.workspaceId || !state.syncScopeId || !state.workspaceKey || !state.workspaceKeys || !state.keyVersion) {
    throw new Error('NoteGen Server 同步工作区尚未解锁')
  }
  return await runNoteGenServerSyncV2Cycle({
    baseUrl: state.profile.baseUrl,
    session: state.session,
    workspaceId: state.profile.workspaceId,
    syncScopeId: state.syncScopeId,
    workspaceKey: state.workspaceKey,
    workspaceKeys: state.workspaceKeys,
    keyVersion: state.keyVersion,
  })
}

function connectEventSocket(): void {
  if (!primaryEnabled || !state?.profile.workspaceId || !state.workspaceKey) return
  const generation = ++socketGeneration
  eventSocket?.close()
  eventSocketAuthenticated = false
  clearRemotePresence()
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer)
  socketReconnectTimer = null

  const url = new URL('/v1/sync/events', state.profile.baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  eventSocket = socket
  socket.addEventListener('open', () => {
    if (generation !== socketGeneration || !state?.profile.workspaceId) return
    socketReconnectDelayMs = 1_000
    socket.send(JSON.stringify({
      type: 'authenticate',
      accessToken: state.session.accessToken,
      workspaceIds: [state.profile.workspaceId],
    }))
  })
  socket.addEventListener('message', event => {
    if (generation !== socketGeneration) return
    try {
      const message = JSON.parse(String(event.data)) as {
        type?: string
        workspaceId?: string
        deleted?: boolean
        documentId?: string
        deviceId?: string
        label?: string
        anchor?: number
        head?: number
        latestSequence?: string
        objectId?: string
        kind?: string
        updateId?: string
        keyVersion?: number
        ciphertext?: string
        ciphertextHash?: string
      }
      if (message.type === 'workspace.changed' && message.workspaceId === state?.profile.workspaceId) {
        void handleWorkspaceChangedNotice(message.latestSequence)
      } else if (message.type === 'workspace.keys-changed'
        && message.workspaceId === state?.profile.workspaceId) {
        void refreshManagedWorkspaceKeys()
      } else if (message.type === 'workspace.state-changed'
        && message.workspaceId === state?.profile.workspaceId && message.deleted) {
        lockNoteGenServerBackgroundWorkspace()
        notifyStatus({
          phase: 'error',
          error: '当前 NoteGen Server 工作区已被删除，请重新连接同步',
          updatedAt: Date.now(),
        })
      } else if (message.type === 'authenticated') {
        eventSocketAuthenticated = true
        for (const subscription of realtimeDocumentSubscriptions.values()) {
          sendRealtimeDocumentSubscription(
            'document.subscribe', subscription.workspaceId, subscription.documentId,
          )
        }
        if (localPresence) publishNoteGenServerPresence(localPresence)
        // A reconnect may have missed events while the app was suspended or offline.
        void triggerNoteGenServerBackgroundSync({ showProgress: false })
      } else if (message.type === 'presence.updated'
        && typeof message.workspaceId === 'string'
        && typeof message.documentId === 'string'
        && typeof message.deviceId === 'string'
        && typeof message.label === 'string'
        && typeof message.anchor === 'number'
        && typeof message.head === 'number') {
        remotePresenceDeviceIds.add(message.deviceId)
        const presence: NoteGenServerPresence = {
          workspaceId: message.workspaceId,
          documentId: message.documentId,
          deviceId: message.deviceId,
          label: message.label,
          anchor: message.anchor,
          head: message.head,
        }
        for (const listener of presenceListeners) listener(presence, message.deviceId)
      } else if (message.type === 'presence.cleared' && typeof message.deviceId === 'string') {
        remotePresenceDeviceIds.delete(message.deviceId)
        for (const listener of presenceListeners) listener(null, message.deviceId)
      } else if (message.type === 'document.updated.realtime'
        && typeof message.workspaceId === 'string'
        && typeof message.documentId === 'string'
        && typeof message.objectId === 'string'
        && typeof message.kind === 'string'
        && typeof message.updateId === 'string'
        && typeof message.keyVersion === 'number'
        && typeof message.ciphertext === 'string'
        && typeof message.ciphertextHash === 'string') {
        const update: NoteGenServerRealtimeDocumentUpdate = {
          workspaceId: message.workspaceId,
          documentId: message.documentId,
          objectId: message.objectId,
          kind: message.kind,
          updateId: message.updateId,
          keyVersion: message.keyVersion,
          ciphertext: message.ciphertext,
          ciphertextHash: message.ciphertextHash,
        }
        for (const listener of documentUpdateListeners) listener(update)
      } else if (message.type === 'document.sync-request'
        && typeof message.workspaceId === 'string'
        && typeof message.documentId === 'string') {
        for (const listener of documentSyncRequestListeners) {
          listener(message.workspaceId, message.documentId)
        }
      }
    } catch {
      // Ignore malformed wake-up messages; the periodic sync remains authoritative.
    }
  })
  socket.addEventListener('close', () => {
    eventSocketAuthenticated = false
    clearRemotePresence()
    scheduleSocketReconnect(generation)
  })
  socket.addEventListener('error', () => socket.close())
}

async function handleWorkspaceChangedNotice(latestSequence?: string): Promise<void> {
  const scopeId = state?.syncScopeId
  if (scopeId && latestSequence && /^\d+$/.test(latestSequence)) {
    try {
      const health = await getSyncV2HealthSnapshot(scopeId)
      if (BigInt(latestSequence) <= BigInt(health.receivedCursor)) return
    } catch {
      // Fall through to the authoritative pull when local cursor inspection fails.
    }
  }
  await triggerNoteGenServerBackgroundSync({ showProgress: false })
}

function clearRemotePresence(): void {
  if (remotePresenceDeviceIds.size === 0) return
  for (const deviceId of remotePresenceDeviceIds) {
    for (const listener of presenceListeners) listener(null, deviceId)
  }
  remotePresenceDeviceIds.clear()
}

async function refreshManagedWorkspaceKeys(): Promise<void> {
  if (!state?.profile.workspaceId || state.profile.encryptionMode !== 'managed') {
    notifyStatus({
      phase: 'error',
      error: '端到端加密工作区密钥已更新，请重新解锁同步',
      updatedAt: Date.now(),
    })
    return
  }
  try {
    if (Date.now() >= state.accessTokenExpiresAt - 60_000) await refreshSession()
    const current = state
    if (!current?.profile.workspaceId) return
    const unlocked = await unlockServerWorkspace({
      baseUrl: current.profile.baseUrl,
      accessToken: current.session.accessToken,
      workspaceId: current.profile.workspaceId,
    })
    unlockNoteGenServerBackgroundWorkspace({
      workspaceKey: unlocked.key,
      workspaceKeys: unlocked.keys,
      keyVersion: unlocked.keyVersion,
    })
    await syncNoteGenServerNow()
  } catch (error) {
    notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
  }
}

function scheduleSocketReconnect(generation: number): void {
  if (!primaryEnabled || generation !== socketGeneration || !state?.workspaceKey) return
  const delay = socketReconnectDelayMs
  socketReconnectDelayMs = Math.min(socketReconnectDelayMs * 2, maximumSocketReconnectDelayMs)
  socketReconnectTimer = setTimeout(() => {
    if (generation === socketGeneration) connectEventSocket()
  }, delay)
}

async function startWorkspaceWatcher(): Promise<void> {
  unwatchWorkspace?.()
  unwatchWorkspace = null
  const workspace = await getWorkspacePath()
  const workspaceRoot = workspace.isCustom
    ? workspace.path
    : await join(await appDataDir(), workspace.path)
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const watchedLocalWorkspaceKey = await getNoteGenServerLocalWorkspaceKey()
  unwatchWorkspace = await watch(workspaceRoot, event => {
    void handleWorkspaceFileEvent(event.paths, normalizedRoot, watchedLocalWorkspaceKey)
  }, { recursive: true, delayMs: 300 })
}

async function handleWorkspaceFileEvent(
  paths: string[],
  normalizedRoot: string,
  watchedLocalWorkspaceKey: string,
): Promise<void> {
  if (await getNoteGenServerLocalWorkspaceKey() !== watchedLocalWorkspaceKey) {
    lockNoteGenServerBackgroundWorkspace()
    notifyStatus({ phase: 'workspace-mismatch', updatedAt: Date.now() })
    return
  }
  let requiresWorkspaceReconciliation = false
  let queuedChange = false
  for (const path of paths) {
    const normalizedPath = path.replace(/\\/g, '/')
    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) continue
    const relativePath = normalizedPath.slice(normalizedRoot.length + 1)
    if (!relativePath || relativePath.split('/').some(part => part.startsWith('.'))) continue
    try {
      const queued = await queueNoteGenServerMarkdownChange(relativePath, true)
      queuedChange ||= queued
      if (!/\.(?:md|markdown)$/i.test(relativePath)) requiresWorkspaceReconciliation = true
    } catch (error) {
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    }
  }
  if (requiresWorkspaceReconciliation) {
    try {
      queuedChange = await queueCurrentNoteGenServerMarkdownWorkspace() > 0 || queuedChange
    } catch (error) {
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    }
  }
  if (queuedChange) void triggerNoteGenServerBackgroundSync()
}

function ensureArticleSavedListener(): void {
  if (articleSavedListenerRegistered) return
  articleSavedListenerRegistered = true
  emitter.on('article-saved', handleArticleSaved)
  emitter.on('article-deleted', handleArticleDeleted)
}

function ensureLifecycleListeners(): void {
  if (lifecycleListenersRegistered || typeof document === 'undefined' || typeof window === 'undefined') return
  lifecycleListenersRegistered = true
  const resume = () => {
    if (document.visibilityState !== 'visible' || !primaryEnabled) return
    if (resumeInFlight) return
    resumeInFlight = resumeNoteGenServerBackgroundRuntime()
      .catch(error => {
        notifyStatus({ phase: 'offline', error: errorMessage(error), updatedAt: Date.now() })
      })
      .finally(() => {
        resumeInFlight = null
      })
  }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  window.addEventListener('focus', resume)
  window.addEventListener('pageshow', resume)
}

async function resumeNoteGenServerBackgroundRuntime(): Promise<void> {
  if (!state) {
    await initNoteGenServerBackgroundRuntime()
  }
  if (!state?.workspaceKey) return
  if (Date.now() >= state.accessTokenExpiresAt - 60_000) {
    try {
      await refreshSession()
    } catch (error) {
      notifyStatus({ phase: 'offline', error: errorMessage(error), updatedAt: Date.now() })
      return
    }
  }
  connectEventSocket()
  await triggerNoteGenServerBackgroundSync()
}

function handleArticleSaved(event: { path: string }): void {
  if (!primaryEnabled) return
  void queueNoteGenServerMarkdownChange(event.path, true)
    .then(queued => {
      if (queued) {
        notifyStatus({ phase: 'pending', updatedAt: Date.now() })
        void triggerNoteGenServerBackgroundSync()
      }
    })
    .catch(error => {
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    })
}

function handleArticleDeleted(event: { path: string }): void {
  if (!primaryEnabled) return
  void queueNoteGenServerMarkdownChange(event.path, false)
    .then(queued => {
      if (queued) {
        notifyStatus({ phase: 'pending', updatedAt: Date.now() })
        void triggerNoteGenServerBackgroundSync()
      }
    })
    .catch(error => {
      notifyStatus({ phase: 'error', error: errorMessage(error), updatedAt: Date.now() })
    })
}

export async function getNoteGenServerLocalWorkspaceKey(): Promise<string> {
  const workspace = await getWorkspacePath()
  if (!workspace.isCustom) return '__default__'
  return workspace.path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

async function activeLocalWorkspaceMatches(): Promise<boolean> {
  if (!state?.profile.localWorkspaceKey) return true
  return state.profile.localWorkspaceKey === await getNoteGenServerLocalWorkspaceKey()
}

function doesProfileMatchLocalWorkspace(profile: NoteGenServerProfile, localWorkspaceKey: string): boolean {
  return !profile.localWorkspaceKey || profile.localWorkspaceKey === localWorkspaceKey
}

function notifySession(session: ServerSession | null): void {
  for (const listener of sessionListeners) listener(session)
}

function notifyStatus(status: NoteGenServerBackgroundStatus): void {
  // Pending work and short sync cycles must not hide an actionable status.
  // Otherwise unresolved conflicts make the UI alternate between
  // "syncing" and "needs attention" on every WebSocket/periodic wake-up.
  if (currentStatus.phase === 'needs-attention'
    && (status.phase === 'saving' || status.phase === 'pending' || status.phase === 'syncing')) {
    currentStatus = { ...currentStatus, updatedAt: status.updatedAt }
    return
  }
  currentStatus = status
  for (const listener of statusListeners) listener(status)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientSyncError(error: unknown): boolean {
  if (error instanceof NoteGenServerRequestError) {
    return error.retryable || error.status === 408 || error.status === 429 || error.status >= 500
  }
  return /fetch|failed to fetch|load failed|network|connection|timed? out|offline|无法连接|网络|连接失败/i.test(errorMessage(error))
}
