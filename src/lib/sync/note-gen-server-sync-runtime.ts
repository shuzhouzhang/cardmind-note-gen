import { dirname } from '@tauri-apps/api/path'
import { exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs'

import {
  blockNoteGenServerOutboxEntry,
  completeNoteGenServerOutboxEntry,
  deleteNoteGenServerOutboxEntry,
  deleteNoteGenServerSyncObject,
  failNoteGenServerOutboxEntry,
  getNoteGenServerOutboxForObject,
  getNoteGenServerSyncQueueStats,
  listNoteGenServerOutbox,
  retireStaleBlockedNoteGenServerOutbox,
} from '@/db/note-gen-server-sync'
import {
  beginSyncEventApply,
  completeSyncCommand,
  completeSyncTransfersForObject,
  completeSyncMutation,
  completeSyncEvent,
  deferSyncEvent,
  clearSyncBootstrapProgress,
  enqueueSyncCommand,
  expireStaleSyncAssetBindings,
  failSyncCommand,
  failSyncEvent,
  getSyncEntity,
  getSyncEntityByLocalKey,
  getSyncConflict,
  getSyncBootstrapProgress,
  getLocalSyncDocument,
  getSyncHealthSnapshot,
  getSyncTransfer,
  getSyncAssetEntityByPath,
  getSyncAssetEntityForOwnerPath,
  hasUnresolvedSyncConflictForObject,
  isSyncFullyConverged,
  isSyncBootstrapComplete,
  listSyncSubtreeEntities,
  listSyncCrdtEntitiesNeedingMaterialization,
  listSyncConflicts,
  listSyncStructuredSnapshotsMissingLocally,
  listOrphanedLocalSyncConflicts,
  listSyncOutbox,
  listRecoverableSyncMutations,
  listRetiredSyncEntities,
  listUnreferencedSyncAssetEntities,
  listRecentActiveSyncTransferBlobIds,
  listUnappliedSyncEvents,
  markSyncSuccessful,
  markSyncServerConfirmed,
  markSyncEntityDocumentMaterialized,
  markSyncBootstrapComplete,
  markSyncAcknowledged,
  markSyncAcknowledgementFailed,
  recoverSyncApplyJournal,
  rebaseSyncDeleteCommand,
  replaceReusedSyncCommand,
  resetSyncForServerEpoch,
  saveSyncBootstrapProgress,
  replaceSyncResourceRefs,
  retireSettledSyncMutations,
  retireBlockedSyncConflictCommand,
  retireSyncEntityIdentity,
  storeSyncEvent,
  setSyncTransfer,
  resolveLocalSyncConflict,
  updateSyncCursor,
  upsertSyncConflict,
  upsertSyncEntity,
  upsertLocalSyncDocument,
  type SyncEntity,
  type SyncHealthSnapshot,
} from '@/db/note-gen-server-sync-index'
import emitter from '@/lib/emitter'
import { ensureSafeWorkspaceRelativePath, getFilePathOptions, getWorkspacePath } from '@/lib/workspace'
import {
  createDeterministicServerObjectId,
  NoteGenServerRequestError,
  type ServerSession,
} from './note-gen-server'
import {
  cleanupStaleNoteGenServerBlobDownloads,
  getNoteGenServerPayloadResourceReferences,
  NoteGenServerAssetLocalConflictError,
  prepareNoteGenServerPayloadAssets,
  restoreNoteGenServerPayloadAssets,
  type NoteGenServerPreparedAssetResource,
} from './note-gen-server-assets'
import {
  acknowledgeSyncEvents,
  bootstrapSync,
  createSyncNameBlindIndex,
  getSyncStableBlindIndexKey,
  getSyncStableBlindIndexKeyVersion,
  decryptSyncPayload,
  encryptSyncPayload,
  pullSyncEvents,
  pushSyncCommands,
  type SyncCommand,
  type SyncEvent,
  type SyncBootstrapObject,
  type SyncObjectKind,
} from './note-gen-server-sync-protocol'

export interface NoteGenServerSyncCycleResult extends SyncHealthSnapshot {
  pushed: number
  pulled: number
  applied: number
  conflicts: string[]
  converged: boolean
}

interface RuntimeInput {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncEpoch?: string
  syncScopeId: string
  workspaceKey: CryptoKey
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  keyVersion: number
  onBootstrapProgress?: (progress: {
    reason: 'initial' | 'cursor-expired'
    processedObjects: number
    restarted: boolean
    complete: boolean
  }) => void
  onTransferProgress?: (progress: { completedBytes: number, totalBytes: number }) => void
}

export class SyncKeyMissingError extends Error {
  constructor(readonly keyVersion: number) {
    super(`缺少 Workspace Key v${keyVersion}`)
    this.name = 'SyncKeyMissingError'
  }
}

let lastBlobDownloadCleanupAt = 0
const reconciledWorkspaces = new Set<string>()
const lastLocalReconciliationAt = new Map<string, number>()
const LOCAL_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const ACK_RETRY_INTERVAL_MS = 60_000
const BLOB_DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000
const ORPHAN_ASSET_GRACE_MS = 7 * 24 * 60 * 60_000
const ASSET_BINDING_TIMEOUT_MS = 24 * 60 * 60_000

export function resetNoteGenServerSyncReconciliation(scopeId?: string): void {
  if (scopeId) {
    reconciledWorkspaces.delete(scopeId)
    lastLocalReconciliationAt.delete(scopeId)
    return
  }
  reconciledWorkspaces.clear()
  lastLocalReconciliationAt.clear()
}

export async function runNoteGenServerSyncCycle(input: RuntimeInput): Promise<NoteGenServerSyncCycleResult> {
  await retireStaleBlockedNoteGenServerOutbox(input.syncScopeId)
  await cleanupStaleBlobDownloads(input.syncScopeId)
  await expireStaleSyncAssetBindings(input.syncScopeId, Date.now() - ASSET_BINDING_TIMEOUT_MS)
  await recoverSyncApplyJournal(input.syncScopeId)
  await recoverReusedSyncCommands(input.syncScopeId)
  // Capture the device's existing workspace before the first remote snapshot
  // can materialize over it. Stable-key collisions then become explicit
  // initial-import/structured conflicts instead of timestamp-based winners.
  if (!await isSyncBootstrapComplete(input.syncScopeId)) await reconcileLocalWorkspace(input)
  await ensureBootstrap(input, 'initial')
  await reconcileCrdtMaterialization(input)
  await reconcileMissingStructuredSnapshots(input)
  await requeueOrphanedLocalConflicts(input)
  await recoverSyncMutations(input)
  // Capture local business/file state before applying newly received events.
  // Otherwise the first cycle after resume can materialize a remote deletion
  // before an existing local value has reached the durable staging outbox,
  // bypassing the structured/delete-vs-edit conflict guard.
  await reconcileLocalWorkspace(input)
  const initialReceived = await receiveEvents(input)
  const initialApplied = await applyInbox(input)
  await enqueueOrphanAssetDeletes(input)
  await enqueueRetiredIdentityDeletes(input)
  await importPendingOperations(input)
  const pushed = await flushSyncOutbox(input)
  const confirmedReceived = await receiveEvents(input)
  const confirmedApplied = await applyInbox(input)
  await resolveLegacyNoteCrdtSnapshotConflicts(input)
  // A create-conflict command can become stale while the authoritative object
  // revision is being pulled. Rebuild that local conflict against the newly
  // applied revision before the follow-up push instead of leaving a permanently
  // blocked immutable command for the user to retry.
  await requeueOrphanedLocalConflicts(input)
  await importPendingOperations(input)
  const followUpPushed = await flushSyncOutbox(input)
  const finalReceived = followUpPushed.count > 0 ? await receiveEvents(input) : 0
  const finalApplied = finalReceived > 0 ? await applyInbox(input) : { count: 0, conflicts: [] }
  await retireSettledSyncMutations(input.syncScopeId)
  await markSyncServerConfirmed(input.syncScopeId)
  let health = await getSyncHealthSnapshot(input.syncScopeId)
  const acknowledgementRetryDue = health.lastAckError === null || health.lastAckError === undefined
    || health.lastAckAttemptAt === null || health.lastAckAttemptAt === undefined
    || Date.now() - health.lastAckAttemptAt >= ACK_RETRY_INTERVAL_MS
  if (health.pendingInbox === 0 && health.failedInbox === 0 && acknowledgementRetryDue
    && health.acknowledgedCursor !== health.receivedCursor) {
    try {
      const acknowledgement = await acknowledgeSyncEvents({
        baseUrl: input.baseUrl, accessToken: input.session.accessToken,
        workspaceId: input.workspaceId, through: health.receivedCursor,
        ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
      })
      await markSyncAcknowledged(input.syncScopeId, acknowledgement.acknowledgedSequence)
    } catch (error) {
      // ACK controls server-side retention; the inbox is already durable and
      // applied locally. A transient ACK failure must not turn converged user
      // content into a visible sync failure. The next cycle retries it.
      console.warn('Failed to acknowledge durable sync cursor:', error)
      await markSyncAcknowledgementFailed(
        input.syncScopeId,
        error instanceof Error ? error.message : String(error),
      ).catch(persistError => console.warn('Failed to persist sync acknowledgement error:', persistError))
    }
    health = await getSyncHealthSnapshot(input.syncScopeId)
  }
  const staging = await getNoteGenServerSyncQueueStats(input.syncScopeId)
  health = { ...health, pendingOutbox: health.pendingOutbox + staging.pendingOutbox,
    blockedOutbox: health.blockedOutbox + staging.blockedOutbox,
    pendingInbox: health.pendingInbox + staging.storedInbox,
    failedInbox: health.failedInbox + staging.failedInbox }
  const converged = isSyncFullyConverged(health)
  if (converged) {
    await markSyncSuccessful(input.syncScopeId)
    health = await getSyncHealthSnapshot(input.syncScopeId)
  }
  return { ...health, pushed: pushed.count + followUpPushed.count,
    pulled: initialReceived + confirmedReceived + finalReceived,
    applied: initialApplied.count + confirmedApplied.count + finalApplied.count,
    conflicts: [...initialApplied.conflicts, ...pushed.conflicts, ...confirmedApplied.conflicts,
      ...followUpPushed.conflicts, ...finalApplied.conflicts], converged }
}

async function recoverReusedSyncCommands(scopeId: string): Promise<void> {
  const entries = await listSyncOutbox(scopeId, 10_000, { includeBlocked: true })
  for (const entry of entries) {
    if (entry.blocked !== 1 || !isRetiredSyncCommandError(entry.lastError)) continue
    // These errors mean the immutable command is stale. The accepted remote
    // revision and any durable conflict record already preserve the useful
    // state; changing the command ID merely creates an infinite retry queue.
    await completeSyncCommand(scopeId, entry.commandId)
    try {
      const command = JSON.parse(entry.commandJson) as { mutationIds?: unknown[] }
      for (const mutationId of command.mutationIds ?? []) {
        if (typeof mutationId === 'string') await completeSyncMutation(scopeId, mutationId)
      }
    } catch {
      // Malformed legacy metadata must not keep a stale command alive.
    }
  }
}

function isRetiredSyncCommandError(value: string | null): boolean {
  return value === 'command_id_reused'
    || value === 'revision_conflict'
    || value === 'conflict_changed'
    || value === 'same_name_still_conflicts'
}

async function reconcileCrdtMaterialization(input: RuntimeInput): Promise<void> {
  const entities = await listSyncCrdtEntitiesNeedingMaterialization(input.syncScopeId)
  for (const entity of entities) await materializeCrdtEntity(input, entity, false)
}

async function reconcileMissingStructuredSnapshots(input: RuntimeInput): Promise<void> {
  let entities = await listSyncStructuredSnapshotsMissingLocally(input.syncScopeId)
  if (entities.length === 0) return
  const dependencyRank = (kind: string) => kind === 'tag' ? 0 : kind === 'mark' ? 1 : kind === 'canvas' ? 2 : 1
  entities = [...entities].sort((left, right) => dependencyRank(left.kind) - dependencyRank(right.kind))
  const domains = await import('./note-gen-server-domains')
  while (entities.length > 0) {
    const deferred: Array<{ entity: typeof entities[number], references: Array<{ kind: 'tag' | 'mark', id: string }> }> = []
    let applied = 0
    for (const entity of entities) {
      const payload = parseJson(entity.basePayloadJson)
      if (!payload) continue
      try {
        await domains.applyNoteGenServerDomainChange({
          syncScopeId: input.syncScopeId, workspaceId: input.workspaceId,
          objectId: entity.objectId, kind: entity.kind, revision: entity.lifecycleRevision,
          payload, deleted: false, stableIdentity: true, refreshView: false,
        })
        applied += 1
      } catch (error) {
        const references = getMissingStructuredReferences(error)
        if (!references) throw error
        deferred.push({ entity, references })
      }
    }
    if (deferred.length === 0) return
    if (applied === 0) {
      let recoveredReference = false
      for (const { references } of deferred) {
        for (const reference of references) {
          if (reference.kind !== 'tag') continue
          recoveredReference = await import('@/db/tags').then(module => (
            module.recoverMissingTagReference(reference.id)
          )) || recoveredReference
        }
      }
      if (!recoveredReference) {
        throw new domains.NoteGenServerMissingReferenceError(deferred.flatMap(item => item.references))
      }
    }
    entities = deferred.map(item => item.entity)
  }
}

async function requeueOrphanedLocalConflicts(input: RuntimeInput): Promise<void> {
  for (const conflict of await listOrphanedLocalSyncConflicts(input.syncScopeId)) {
    const entity = await getSyncEntity(input.syncScopeId, conflict.objectId)
    const payload = parseJson(conflict.payloadJson)
    if (!entity || !payload) continue
    const identity = `${conflict.conflictId}:${entity.lifecycleRevision}:${entity.documentSequence}`
    const conflictId = await createDeterministicServerObjectId(
      input.workspaceId, 'requeued-conflict', identity,
    )
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'requeued-conflict-command', identity,
    )
    const encrypted = await encryptSyncPayload(input.workspaceKey, payload, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
      keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
    })
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      type: 'create-conflict', commandId, conflictId, objectId: entity.objectId,
      kind: entity.kind as SyncObjectKind, conflictType: conflict.type,
      expectedRevision: entity.lifecycleRevision === '0' ? null : entity.lifecycleRevision,
      expectedDocumentSequence: entity.documentId ? entity.documentSequence : null,
      keyVersion: input.keyVersion, ...encrypted,
    } })
    await upsertSyncConflict({
      ...conflict, conflictId, createdAt: Date.now(), payloadJson: JSON.stringify(payload),
    })
    await retireBlockedSyncConflictCommand(input.syncScopeId, conflict.conflictId)
    await resolveLocalSyncConflict(input.syncScopeId, conflict.conflictId)
  }
}

async function materializeCrdtEntity(
  input: RuntimeInput,
  entity: SyncEntity,
  refreshView: boolean,
): Promise<void> {
  if (entity.kind === 'note') {
    const snapshot = await import('./note-gen-server-collab').then(module => (
      module.loadNoteGenServerStructuredSnapshot({
        workspaceId: input.workspaceId,
        entity,
      })
    ))
    if (!snapshot || snapshot.markdown === null) return
    const path = await ensureSafeWorkspaceRelativePath(entity.localKey)
    const current = await readWorkspaceFile(path)
    if (current !== snapshot.markdown) {
      const outbox = await import('./note-gen-server-outbox')
      outbox.suppressNoteGenServerFileEvent(
        path,
        await outbox.hashMarkdownContent(snapshot.markdown),
      )
      await import('@/stores/article').then(module => module.acceptArticlePathFromSync(path))
      await writeWorkspaceFile(path, snapshot.markdown)
      if (refreshView) {
        emitter.emit('sync-content-updated', { path, content: snapshot.markdown })
      }
    }
    await markSyncEntityDocumentMaterialized(
      input.syncScopeId, entity.objectId, entity.documentSequence,
    )
    return
  }
  const materialized = await import('./note-gen-server-domains').then(module => (
    module.materializeNoteGenServerCrdtEntity({
      syncScopeId: input.syncScopeId, workspaceId: input.workspaceId, entity, refreshView,
    })
  ))
  if (materialized) {
    await markSyncEntityDocumentMaterialized(
      input.syncScopeId, entity.objectId, entity.documentSequence,
    )
  }
}

async function resolveLegacyNoteCrdtSnapshotConflicts(input: RuntimeInput): Promise<void> {
  for (const conflict of await listSyncConflicts(input.syncScopeId)) {
    if (conflict.kind !== 'note' || conflict.type !== 'initial-import'
      || conflict.createdSequence === '0') continue
    const payload = parseJson(conflict.payloadJson) as {
      base?: unknown
      remote?: unknown
    } | null
    if (payload?.base !== '' || payload.remote !== '') continue
    const entity = await getSyncEntity(input.syncScopeId, conflict.objectId)
    const lifecycle = parseJson(entity?.basePayloadJson ?? '') as { type?: unknown } | null
    if (!entity || lifecycle?.type !== 'crdt-object') continue
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'resolve-legacy-note-crdt-conflict', conflict.conflictId,
    )
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      type: 'resolve-conflict', commandId, conflictId: conflict.conflictId,
      expectedCreatedSequence: conflict.createdSequence,
    } })
  }
}

async function reconcileLocalWorkspace(input: RuntimeInput): Promise<void> {
  const now = Date.now()
  if (reconciledWorkspaces.has(input.syncScopeId)
    && now - (lastLocalReconciliationAt.get(input.syncScopeId) ?? 0) < LOCAL_RECONCILIATION_INTERVAL_MS) {
    return
  }
  await import('./note-gen-server-outbox').then(module => (
    module.queueCurrentNoteGenServerMarkdownWorkspace()
  ))
  await import('./note-gen-server-domains').then(module => module.queueCurrentNoteGenServerAppData())
  reconciledWorkspaces.add(input.syncScopeId)
  lastLocalReconciliationAt.set(input.syncScopeId, now)
}

async function enqueueOrphanAssetDeletes(input: RuntimeInput): Promise<void> {
  const candidates = await listUnreferencedSyncAssetEntities(
    input.syncScopeId, Date.now() - ORPHAN_ASSET_GRACE_MS,
  )
  for (const entity of candidates) {
    if (await hasUnresolvedSyncConflictForObject(input.syncScopeId, entity.objectId)) continue
    const payload = parseJson(entity.basePayloadJson) as {
      resourceId?: string
      blobId?: string
      localPath?: string
    } | null
    // Only resource objects created by the attachment binding graph are safe
    // to collect; unrelated asset-shaped records must never be inferred as orphans.
    if (payload?.resourceId !== entity.objectId) continue
    const commandId = crypto.randomUUID()
    const conflictId = crypto.randomUUID()
    const envelope = await encryptSyncPayload(input.workspaceKey, payload ?? {
      schemaVersion: 2, type: 'asset', resourceId: entity.objectId,
    }, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: 'asset',
      keyVersion: input.keyVersion, purpose: 'object', identity: entity.objectId,
    })
    const conflictEnvelope = await encryptSyncPayload(input.workspaceKey, {
      schemaVersion: 2, type: 'delete-orphan-asset', resourceId: entity.objectId,
      path: payload?.localPath ?? entity.name,
    }, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: 'asset',
      keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
    })
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      commandId, type: 'delete-object', objectId: entity.objectId, kind: 'asset',
      parentObjectId: null, nameCiphertext: envelope.ciphertext,
      baseRevision: entity.lifecycleRevision, expectedDocumentSequence: '0',
      blobRefs: typeof payload?.blobId === 'string' ? [payload.blobId] : [],
      keyVersion: input.keyVersion, ...envelope, conflictId,
      conflictCiphertext: conflictEnvelope.ciphertext,
      conflictCiphertextHash: conflictEnvelope.ciphertextHash,
    } })
  }
}

async function enqueueRetiredIdentityDeletes(input: RuntimeInput): Promise<void> {
  for (const entity of await listRetiredSyncEntities(input.syncScopeId)) {
    const identity = `${entity.objectId}:${entity.lifecycleRevision}:${entity.documentSequence}`
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'retire-superseded-sync-identity', identity,
    )
    const conflictId = await createDeterministicServerObjectId(
      input.workspaceId, 'retire-superseded-sync-identity-conflict', identity,
    )
    const payload = {
      schemaVersion: 2, type: 'crdt-object', localKey: entity.localKey,
      documentId: entity.documentId, retiredIdentity: true,
    }
    const [encrypted, conflictEnvelope] = await Promise.all([
      encryptSyncPayload(input.workspaceKey, payload, {
        workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: input.keyVersion, purpose: 'object', identity: entity.objectId,
      }),
      encryptSyncPayload(input.workspaceKey, {
        schemaVersion: 2, type: 'retire-superseded-identity', objectId: entity.objectId,
      }, {
        workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
      }),
    ])
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      type: 'delete-object', commandId, objectId: entity.objectId, kind: entity.kind,
      parentObjectId: entity.parentObjectId, nameCiphertext: encrypted.ciphertext,
      baseRevision: entity.lifecycleRevision,
      expectedDocumentSequence: entity.documentSequence,
      blobRefs: [], keyVersion: input.keyVersion, ...encrypted, conflictId,
      conflictCiphertext: conflictEnvelope.ciphertext,
      conflictCiphertextHash: conflictEnvelope.ciphertextHash,
    } })
  }
}

async function cleanupStaleBlobDownloads(scopeId: string): Promise<void> {
  const now = Date.now()
  if (now - lastBlobDownloadCleanupAt < 24 * 60 * 60_000) return
  lastBlobDownloadCleanupAt = now
  const cutoff = now - BLOB_DOWNLOAD_RETENTION_MS
  try {
    const active = new Set(await listRecentActiveSyncTransferBlobIds(scopeId, cutoff))
    await cleanupStaleNoteGenServerBlobDownloads(active, cutoff)
  } catch (error) {
    console.warn('Failed to clean stale NoteGen Server Blob downloads:', error)
  }
}

async function recoverSyncMutations(input: RuntimeInput): Promise<void> {
  const recoverable = await listRecoverableSyncMutations(input.syncScopeId)
  if (recoverable.length === 0) return
  const kinds = new Set(recoverable.map(item => item.kind))
  if ([...kinds].some(kind => kind === 'note' || kind === 'folder')) {
    await import('./note-gen-server-outbox').then(module => (
      module.queueCurrentNoteGenServerMarkdownWorkspace()
    ))
  }
  const domains = new Set<string>()
  for (const kind of kinds) {
    if (kind === 'tag' || kind === 'mark' || kind === 'canvas') domains.add('records')
    else if (kind === 'setting') domains.add('settings')
    else if (kind === 'conversation') domains.add('conversations')
    else if (kind === 'memory') domains.add('memories')
  }
  for (const domain of domains) {
    await import('./note-gen-server-domains').then(module => (
      module.queueNoteGenServerDomainChange(domain as import('./note-gen-server-domains').NoteGenServerDataDomain)
    ))
  }
  // A successful full rescan either recreated an equivalent durable outbox
  // command or proved that the local state already matches its baseline.
  for (const mutation of recoverable) {
    await completeSyncMutation(input.syncScopeId, mutation.mutationId)
  }
}

type DeferredBootstrapObject = {
  object: SyncBootstrapObject
  payload: unknown
  resolvedParentObjectId: string | null
  snapshotSequence: string
  discoveredReferences?: BootstrapReference[]
}

function markTagSyncId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>).value
  if (!value || typeof value !== 'object') return null
  const tagSyncId = (value as Record<string, unknown>).tagSyncId
  return typeof tagSyncId === 'string' && tagSyncId.length > 0 ? tagSyncId : null
}

type BootstrapReference = { kind: 'tag' | 'mark', id: string }

function bootstrapReferences(entry: DeferredBootstrapObject): BootstrapReference[] {
  if (entry.object.deletedAt) return []
  const references = new Map<string, BootstrapReference>()
  for (const reference of entry.discoveredReferences ?? []) {
    references.set(`${reference.kind}:${reference.id}`, reference)
  }
  if (entry.object.kind === 'mark') {
    const tagSyncId = markTagSyncId(entry.payload)
    if (tagSyncId) references.set(`tag:${tagSyncId}`, { kind: 'tag', id: tagSyncId })
    return Array.from(references.values())
  }
  if (entry.object.kind !== 'canvas' || !entry.payload || typeof entry.payload !== 'object') {
    return Array.from(references.values())
  }
  const value = (entry.payload as Record<string, unknown>).value
  if (!value || typeof value !== 'object') return Array.from(references.values())
  const document = (value as Record<string, unknown>).document
  if (!document || typeof document !== 'object') return Array.from(references.values())
  const nodes = (document as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return Array.from(references.values())
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const data = (node as Record<string, unknown>).data
    if (!data || typeof data !== 'object') continue
    const recordSyncId = (data as Record<string, unknown>).recordSyncId
    if (typeof recordSyncId === 'string' && recordSyncId.length > 0) ids.add(recordSyncId)
  }
  for (const id of ids) references.set(`mark:${id}`, { kind: 'mark', id })
  return Array.from(references.values())
}

function getDiscoveredBootstrapReferences(error: unknown): BootstrapReference[] | null {
  if (!error || typeof error !== 'object'
    || (error as { code?: unknown }).code !== 'note_gen_server_missing_reference') return null
  const references = (error as { references?: unknown }).references
  if (!Array.isArray(references)) return null
  const valid = references.filter((reference): reference is BootstrapReference => (
    Boolean(reference)
    && typeof reference === 'object'
    && ((reference as BootstrapReference).kind === 'tag' || (reference as BootstrapReference).kind === 'mark')
    && typeof (reference as BootstrapReference).id === 'string'
    && (reference as BootstrapReference).id.length > 0
  ))
  return valid.length > 0 ? valid : null
}

async function tryMaterializeBootstrapObject(
  input: RuntimeInput,
  entry: DeferredBootstrapObject,
): Promise<boolean> {
  try {
    await materializeBootstrapObject(input, entry)
    return true
  } catch (error) {
    const references = getDiscoveredBootstrapReferences(error)
    if (!references) throw error
    entry.discoveredReferences = references
    return false
  }
}

async function bootstrapDependencyReady(entry: DeferredBootstrapObject): Promise<boolean> {
  const references = bootstrapReferences(entry)
  if (references.length === 0) return true
  const resolved = await Promise.all(references.map(reference => (
    reference.kind === 'tag'
      ? import('@/db/tags').then(module => module.getTagBySyncId(reference.id))
      : import('@/db/marks').then(module => module.getMarkBySyncId(reference.id))
  )))
  return resolved.every(Boolean)
}

async function materializeBootstrapObject(
  input: RuntimeInput,
  entry: DeferredBootstrapObject,
): Promise<void> {
  const { object, payload, resolvedParentObjectId, snapshotSequence } = entry
  await materializeObject(input, {
    eventId: `bootstrap:${object.objectId}:${object.currentRevision}`,
    sequence: snapshotSequence, commandId: crypto.randomUUID(), sourceDeviceId: 'bootstrap',
    type: object.deletedAt ? 'object.deleted' : 'object.upserted', objectId: object.objectId,
    documentId: object.document?.documentId ?? null,
    documentSequence: object.document?.latestDocumentSequence ?? null,
    keyVersion: object.keyVersion, ciphertext: object.ciphertext,
    ciphertextHash: object.ciphertextHash,
    metadata: { kind: object.kind, revision: object.currentRevision, blobRefs: object.blobRefs,
      parentObjectId: resolvedParentObjectId },
    createdAt: new Date().toISOString(),
  }, object.kind, payload)
  if (!object.nameBlindIndexPresent && ['note', 'folder'].includes(object.kind)
    && !await hasUnresolvedSyncConflictForObject(input.syncScopeId, object.objectId)) {
    const logicalKey = logicalKeyForPayload(payload, object.objectId)
    const name = logicalKey.split('/').filter(Boolean).at(-1) ?? logicalKey
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'blind-index-backfill', `${object.objectId}:${object.currentRevision}`,
    )
    const conflictId = await createDeterministicServerObjectId(
      input.workspaceId, 'blind-index-conflict', `${object.objectId}:${object.currentRevision}`,
    )
    const [envelope, conflictEnvelope] = await Promise.all([
      encryptSyncPayload(input.workspaceKey, payload, {
        workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
        keyVersion: input.keyVersion, purpose: 'object', identity: object.objectId,
      }),
      encryptSyncPayload(input.workspaceKey, {
        schemaVersion: 2, type: 'same-name', objectId: object.objectId,
        parentObjectId: resolvedParentObjectId, path: logicalKey, name,
      }, {
        workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
      }),
    ])
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      type: 'upsert-object', commandId, objectId: object.objectId, kind: object.kind,
      parentObjectId: resolvedParentObjectId, nameCiphertext: envelope.ciphertext,
      nameBlindIndex: await createSyncNameBlindIndex({
        key: getSyncStableBlindIndexKey(input.workspaceKeys, input.workspaceKey),
        workspaceId: input.workspaceId, parentObjectId: resolvedParentObjectId, name,
      }),
      nameBlindIndexKeyVersion: getSyncStableBlindIndexKeyVersion(input.workspaceKeys),
      nameConflictId: conflictId, nameConflictCiphertext: conflictEnvelope.ciphertext,
      nameConflictCiphertextHash: conflictEnvelope.ciphertextHash,
      baseRevision: object.currentRevision, blobRefs: object.blobRefs,
      keyVersion: input.keyVersion, ...envelope,
    } })
  }
  if (object.document) {
    await upsertLocalSyncDocument({
      scopeId: input.syncScopeId, documentId: object.document.documentId,
      objectId: object.objectId, kind: object.kind,
      latestDocumentSequence: object.document.latestDocumentSequence,
      checkpointDocumentSequence: object.document.checkpointDocumentSequence,
      checkpointId: object.document.checkpointId,
      checkpointKeyVersion: object.document.checkpointKeyVersion,
      checkpointCiphertext: object.document.checkpointCiphertext,
      checkpointCiphertextHash: object.document.checkpointCiphertextHash,
    })
    const entity = await getSyncEntity(input.syncScopeId, object.objectId)
    if (entity && payload && typeof payload === 'object'
      && (payload as Record<string, unknown>).type === 'crdt-object') {
      await materializeCrdtEntity(input, entity, false)
    }
  }
}

async function materializeMissingReferenceConflict(
  input: RuntimeInput,
  entry: DeferredBootstrapObject,
): Promise<void> {
  const { object, payload } = entry
  const logicalKey = logicalKeyForPayload(payload, object.objectId)
  const current = await getSyncEntity(input.syncScopeId, object.objectId)
  const entity: SyncEntity = current ?? {
    scopeId: input.syncScopeId, objectId: object.objectId, kind: object.kind,
    localKey: `__sync_pending__/${object.objectId}`,
    parentObjectId: entry.resolvedParentObjectId,
    name: logicalKey.split('/').at(-1) ?? logicalKey,
    lifecycleRevision: '0', documentId: null, documentSequence: '0',
    materializedHash: null, basePayloadJson: null, deleted: 0,
  }
  const references = bootstrapReferences(entry)
  const referenceIdentity = references.map(reference => `${reference.kind}:${reference.id}`).sort().join(',')
  const identity = `${object.objectId}:${object.currentRevision}:${referenceIdentity || 'unknown'}`
  const conflictId = await createDeterministicServerObjectId(
    input.workspaceId, 'bootstrap-reference-conflict', identity,
  )
  const commandId = await createDeterministicServerObjectId(
    input.workspaceId, 'bootstrap-reference-conflict-command', identity,
  )
  const conflictPayload = {
    schemaVersion: 2,
    type: 'reference-target-deleted',
    objectId: object.objectId,
    references,
    ...(references.length === 1 ? {
      referenceKind: references[0]!.kind,
      referenceId: references[0]!.id,
    } : {}),
    remote: payload,
  }
  const encrypted = await encryptSyncPayload(input.workspaceKey, conflictPayload, {
    workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
    keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
    type: 'create-conflict', commandId, conflictId, objectId: object.objectId, kind: object.kind,
    conflictType: 'reference-target-deleted', expectedRevision: object.currentRevision,
    expectedDocumentSequence: entity.documentSequence, keyVersion: input.keyVersion, ...encrypted,
  } })
  await upsertSyncConflict({
    scopeId: input.syncScopeId, conflictId, objectId: object.objectId, kind: object.kind,
    type: 'reference-target-deleted', status: 'unresolved', createdSequence: '0',
    payloadJson: JSON.stringify(conflictPayload), createdAt: Date.now(), resolvedAt: null,
  })
  await upsertSyncEntity({
    ...entity,
    lifecycleRevision: object.currentRevision,
    basePayloadJson: JSON.stringify(payload),
  })
}

async function ensureBootstrap(input: RuntimeInput, reason: 'initial' | 'cursor-expired'): Promise<void> {
  if (await isSyncBootstrapComplete(input.syncScopeId)) return
  const savedProgress = await getSyncBootstrapProgress(input.syncScopeId)
  let afterObjectId = savedProgress?.afterObjectId ?? undefined
  let bootstrapId = savedProgress?.bootstrapId
  let snapshotSequence = savedProgress?.snapshotSequence ?? '0'
  let deferredObjects: DeferredBootstrapObject[] = []
  const bootstrapKinds = new Set<string>([
    'note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark',
    'conversation', 'memory', 'setting',
  ])
  let restartedExpiredSnapshot = false
  let processedObjects = 0
  input.onBootstrapProgress?.({ reason, processedObjects, restarted: false, complete: false })
  do {
    let page: Awaited<ReturnType<typeof bootstrapSync>>
    try {
      page = await bootstrapSync({
        baseUrl: input.baseUrl, accessToken: input.session.accessToken,
        workspaceId: input.workspaceId, ...(bootstrapId ? { bootstrapId } : {}),
        ...(afterObjectId ? { afterObjectId } : {}),
        ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
        // Keep encrypted bootstrap responses small enough for mobile WebViews
        // and yield frequently while materializing large workspaces.
        limit: 50,
      })
    } catch (error) {
      if (!restartedExpiredSnapshot && error instanceof NoteGenServerRequestError
        && error.code === 'bootstrap_expired') {
        restartedExpiredSnapshot = true
        await clearSyncBootstrapProgress(input.syncScopeId)
        bootstrapId = undefined
        afterObjectId = undefined
        snapshotSequence = '0'
        deferredObjects = []
        processedObjects = 0
        input.onBootstrapProgress?.({ reason, processedObjects, restarted: true, complete: false })
        continue
      }
      throw error
    }
    if ((bootstrapId !== undefined && bootstrapId !== page.bootstrapId)
      || (snapshotSequence !== '0' && snapshotSequence !== page.snapshotSequence)) {
      await clearSyncBootstrapProgress(input.syncScopeId)
      throw new Error('服务端 Bootstrap 快照在分页期间发生变化')
    }
    bootstrapId = page.bootstrapId
    snapshotSequence = page.snapshotSequence
    for (const object of page.objects) {
      try {
        bootstrapKinds.add(object.kind)
        const migratedEntity = await getSyncEntity(input.syncScopeId, object.objectId)
        const resolvedParentObjectId = object.parentObjectId ?? migratedEntity?.parentObjectId ?? null
        const key = input.workspaceKeys.get(object.keyVersion)
        if (!key) throw new SyncKeyMissingError(object.keyVersion)
        const payload = await decryptSyncPayload(key, object.ciphertext, {
          workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
          keyVersion: object.keyVersion, purpose: 'object', identity: object.objectId,
        }, false, true)
        const entry = { object, payload, resolvedParentObjectId, snapshotSequence }
        if (!await bootstrapDependencyReady(entry)
          || !await tryMaterializeBootstrapObject(input, entry)) deferredObjects.push(entry)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Bootstrap 对象 ${object.objectId} (${object.kind}) 应用失败：${message}`, { cause: error })
      }
    }
    processedObjects += page.objects.length
    input.onBootstrapProgress?.({ reason, processedObjects, restarted: restartedExpiredSnapshot, complete: false })
    if (deferredObjects.length > 0) {
      const stillDeferred: DeferredBootstrapObject[] = []
      for (const entry of deferredObjects) {
        if (!await bootstrapDependencyReady(entry)
          || !await tryMaterializeBootstrapObject(input, entry)) stillDeferred.push(entry)
      }
      deferredObjects = stillDeferred
    }
    for (const conflict of page.conflicts) {
      await applyConflictCreated(input, {
        eventId: `bootstrap-conflict:${conflict.conflictId}`,
        sequence: conflict.createdSequence, commandId: crypto.randomUUID(), sourceDeviceId: 'bootstrap',
        type: 'conflict.created', objectId: conflict.objectId, documentId: null, documentSequence: null,
        keyVersion: conflict.keyVersion, ciphertext: conflict.ciphertext,
        ciphertextHash: conflict.ciphertextHash,
        metadata: { conflictId: conflict.conflictId, conflictType: conflict.type, kind: conflict.kind },
        createdAt: new Date().toISOString(),
      })
    }
    afterObjectId = page.nextObjectId ?? undefined
    if (deferredObjects.length === 0 && page.hasMore && afterObjectId) {
      await saveSyncBootstrapProgress(input.syncScopeId, {
        bootstrapId: page.bootstrapId,
        snapshotSequence: page.snapshotSequence,
        afterObjectId,
      })
    }
    if (!page.hasMore) break
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  } while (afterObjectId)
  for (const entry of deferredObjects) await materializeMissingReferenceConflict(input, entry)
  await import('./note-gen-server-domains').then(module => (
    module.refreshNoteGenServerBootstrapViews(bootstrapKinds)
  ))
  await markSyncBootstrapComplete(input.syncScopeId, snapshotSequence)
  input.onBootstrapProgress?.({ reason, processedObjects, restarted: restartedExpiredSnapshot, complete: true })
}

async function importPendingOperations(input: RuntimeInput): Promise<void> {
  const entries = await listNoteGenServerOutbox(input.syncScopeId, 10_000)
  const consumedObjectIds = new Set<string>()
  const folderDeletes = entries.filter(entry => entry.action === 'delete' && entry.kind === 'folder')
    .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length)
  for (const rootEntry of folderDeletes) {
    if (consumedObjectIds.has(rootEntry.objectId)) continue
    const subtree = (await listSyncSubtreeEntities(input.syncScopeId, rootEntry.objectId))
      .filter(entity => entity.lifecycleRevision !== '0')
    if (subtree.length === 0) {
      await deleteNoteGenServerOutboxEntry(rootEntry.id, rootEntry.operationId)
      continue
    }
    const conflictId = crypto.randomUUID()
    const conflictEnvelope = await encryptSyncPayload(input.workspaceKey, {
      schemaVersion: 2, type: 'delete-subtree-vs-edit', rootObjectId: rootEntry.objectId,
      path: rootEntry.relativePath, objectIds: subtree.map(entity => entity.objectId),
      deletionRequestedLocally: true,
    }, {
      workspaceId: input.workspaceId, objectId: rootEntry.objectId, kind: 'folder',
      keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
    })
    const items: Array<Record<string, unknown>> = []
    for (const entity of subtree) {
      const payload = parseJson(entity.basePayloadJson) ?? {
        schemaVersion: 2, type: 'deleted-object', localKey: entity.localKey,
      }
      const envelope = await encryptSyncPayload(input.workspaceKey, payload, {
        workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: input.keyVersion, purpose: 'object', identity: entity.objectId,
      })
      items.push({
        objectId: entity.objectId, kind: entity.kind, baseRevision: entity.lifecycleRevision,
        expectedDocumentSequence: entity.documentSequence, blobRefs: [],
        keyVersion: input.keyVersion, ...envelope,
      })
      consumedObjectIds.add(entity.objectId)
    }
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      commandId: rootEntry.operationId, type: 'delete-subtree', rootObjectId: rootEntry.objectId,
      conflictId, conflictKeyVersion: input.keyVersion,
      conflictCiphertext: conflictEnvelope.ciphertext,
      conflictCiphertextHash: conflictEnvelope.ciphertextHash,
      mutationIds: entries.filter(entry => consumedObjectIds.has(entry.objectId)).map(entry => entry.operationId),
      objects: items,
    } })
    for (const entry of entries) {
      if (consumedObjectIds.has(entry.objectId)) {
        await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
      }
    }
  }
  const orderedEntries = [...entries].sort((left, right) => {
    const leftRank = left.action === 'upsert' && left.kind === 'folder' ? 0
      : left.action === 'upsert' ? 1 : 2
    const rightRank = right.action === 'upsert' && right.kind === 'folder' ? 0
      : right.action === 'upsert' ? 1 : 2
    if (leftRank !== rightRank) return leftRank - rightRank
    if (leftRank === 0) return left.relativePath.split('/').length - right.relativePath.split('/').length
    return left.createdAt - right.createdAt || left.id - right.id
  })
  const stagedAssetResources = new Map<string, NoteGenServerPreparedAssetResource>()
  for (const entry of orderedEntries) {
    if (consumedObjectIds.has(entry.objectId)) continue
    if (await hasUnresolvedSyncConflictForObject(input.syncScopeId, entry.objectId)) {
      // The conflict envelope already durably preserves this local intent.
      // Keeping the staging entry makes every reconciliation cycle rediscover
      // and retry the same mutation while the user has done nothing.
      await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
      await completeSyncMutation(input.syncScopeId, entry.operationId)
      continue
    }
    const entity = await getSyncEntity(input.syncScopeId, entry.objectId)
    const localPayload = entry.payloadJson ? JSON.parse(entry.payloadJson) : {}
    const transferId = `object-upload:${entry.operationId}`
    const existingBinding = getAssetBinding(parseJson(entity?.basePayloadJson ?? null))
    const hasAssets = hasPayloadAssets(localPayload)
    const stageAssetBinding = entry.action === 'upsert' && hasAssets
      && !(existingBinding?.operationId === entry.operationId
        && (existingBinding.state === 'uploading' || existingBinding.state === 'failed'))
    let commandId = stageAssetBinding
      ? await createDeterministicServerObjectId(
          input.workspaceId, 'asset-binding-placeholder', entry.operationId,
        )
      : entry.operationId
    let prepared: {
      payload: unknown
      blobRefs: string[]
      resources: NoteGenServerPreparedAssetResource[]
    }
    try {
      await setSyncTransfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
        direction: 'upload', state: entry.action === 'delete' ? 'complete'
          : stageAssetBinding ? 'pending' : 'running' })
      prepared = entry.action === 'delete'
        ? { payload: localPayload, blobRefs: [], resources: [] }
        : stageAssetBinding
          ? { payload: withAssetBinding(localPayload, entry.operationId, 'uploading'), blobRefs: [], resources: [] }
        : await prepareNoteGenServerPayloadAssets({
            payload: localPayload, baseUrl: input.baseUrl, accessToken: input.session.accessToken,
            workspaceId: input.workspaceId, workspaceKey: input.workspaceKey,
            ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
            keyVersion: input.keyVersion,
            resolveResourceId: async reference => {
              const resourceEntity = await getOrCreateAssetResourceEntity(
                input.syncScopeId, entry.objectId, reference.localPath,
                reference.scope ?? 'appData', reference.contentHash,
              )
              const base = parseJson(resourceEntity.basePayloadJson) as {
                contentHash?: string
                blobId?: string
                blobKeyVersion?: number
              } | null
              return {
                resourceId: resourceEntity.objectId,
                ...(base?.contentHash === reference.contentHash
                  && base.blobKeyVersion === input.keyVersion && typeof base.blobId === 'string'
                  ? { existingBlobId: base.blobId } : {}),
              }
            },
            onTransferProgress: async progress => {
              input.onTransferProgress?.(progress)
              await setSyncTransfer({
                scopeId: input.syncScopeId, transferId: `blob-upload:${progress.blobId}`,
                objectId: entry.objectId, blobId: progress.blobId, direction: 'upload',
                state: progress.completedBytes >= progress.totalBytes ? 'complete' : 'running',
                completedBytes: progress.completedBytes, totalBytes: progress.totalBytes,
              })
            },
          })
      if (!stageAssetBinding && entry.action === 'upsert' && hasAssets) {
        prepared.payload = withAssetBinding(prepared.payload, entry.operationId, 'ready')
      }
      await setSyncTransfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
        direction: 'upload', state: stageAssetBinding ? 'pending' : 'complete' })
    } catch (error) {
      const message = errorMessage(error)
      await setSyncTransfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
        direction: 'upload', state: 'failed', error: message })
      const failedTransfer = await getSyncTransfer(input.syncScopeId, transferId)
      const permanentlyFailed = !stageAssetBinding && entry.action === 'upsert' && hasAssets
        && failedTransfer !== null && failedTransfer.attempts >= 3
        && entity !== null && entity.lifecycleRevision !== '0'
      if (!permanentlyFailed) {
        await failNoteGenServerOutboxEntry(entry.id, entry.operationId, message)
        throw error
      }
      await blockNoteGenServerOutboxEntry(entry.id, entry.operationId, message)
      prepared = {
        payload: withAssetBinding(localPayload, entry.operationId, 'failed', message),
        blobRefs: [],
        resources: [],
      }
      commandId = await createDeterministicServerObjectId(
        input.workspaceId, 'asset-binding-failed', entry.operationId,
      )
    }
    if (entry.action === 'upsert' && prepared.resources.length > 0) {
      for (const resource of prepared.resources) {
        const staged = stagedAssetResources.get(resource.resourceId)
        if (staged && staged.contentHash !== resource.contentHash) {
          throw new Error(`同一轮同步对附件资源产生了两个不同版本：${resource.localPath}`)
        }
        if (!staged) {
          await enqueuePreparedAssetResource(input, entry.operationId, resource)
          stagedAssetResources.set(resource.resourceId, resource)
        }
      }
      await replaceSyncResourceRefs({
        scopeId: input.syncScopeId,
        ownerObjectId: entry.objectId,
        resources: prepared.resources.map(resource => ({
          resourceObjectId: resource.resourceId,
          localPath: resource.localPath,
        })),
      })
    } else if (entry.action === 'upsert' && !stageAssetBinding && !hasAssets) {
      await replaceSyncResourceRefs({
        scopeId: input.syncScopeId, ownerObjectId: entry.objectId, resources: [],
      })
    }
    const envelope = await encryptSyncPayload(input.workspaceKey, prepared.payload, {
      workspaceId: input.workspaceId, objectId: entry.objectId, kind: entry.kind,
      keyVersion: input.keyVersion, purpose: 'object', identity: entry.objectId,
    })
    let command: SyncCommand
    if (entry.action === 'delete') {
      if (!entity || entity.lifecycleRevision === '0') {
        await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
        continue
      }
      const conflictId = crypto.randomUUID()
      const basePayload = parseJson(entity.basePayloadJson) as { relativePath?: string, content?: string } | null
      const conflictEnvelope = await encryptSyncPayload(input.workspaceKey, {
        schemaVersion: 2, type: 'delete-vs-edit',
        path: basePayload?.relativePath ?? entry.relativePath,
        base: basePayload?.content ?? '', local: basePayload?.content ?? '', remote: null,
        deletionRequestedLocally: true,
      }, {
        workspaceId: input.workspaceId, objectId: entry.objectId, kind: entry.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
      })
      command = {
        commandId, type: 'delete-object', objectId: entry.objectId,
        kind: entry.kind, parentObjectId: entity.parentObjectId, nameCiphertext: envelope.ciphertext,
        baseRevision: entity.lifecycleRevision,
        expectedDocumentSequence: entity.documentSequence, blobRefs: prepared.blobRefs,
        keyVersion: input.keyVersion, ...envelope, conflictId,
        conflictCiphertext: conflictEnvelope.ciphertext,
        conflictCiphertextHash: conflictEnvelope.ciphertextHash,
      }
    } else {
      const parentObjectId = entity?.parentObjectId ?? null
      const name = entry.relativePath.split('/').filter(Boolean).at(-1) ?? entry.relativePath
      const nameConflictId = crypto.randomUUID()
      const nameConflictEnvelope = await encryptSyncPayload(input.workspaceKey, {
        schemaVersion: 2, type: 'same-name', objectId: entry.objectId,
        parentObjectId, path: entry.relativePath, name,
      }, {
        workspaceId: input.workspaceId, objectId: entry.objectId, kind: entry.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: nameConflictId,
      })
      command = {
        commandId, type: 'upsert-object', objectId: entry.objectId,
        kind: entry.kind, parentObjectId,
        nameCiphertext: envelope.ciphertext, baseRevision: entity?.lifecycleRevision === '0'
          ? null : entity?.lifecycleRevision ?? entry.baseRevision,
        ...(['note', 'folder'].includes(entry.kind) ? {
          nameBlindIndex: await createSyncNameBlindIndex({
            key: getSyncStableBlindIndexKey(input.workspaceKeys, input.workspaceKey),
            workspaceId: input.workspaceId, parentObjectId, name,
          }),
          nameBlindIndexKeyVersion: getSyncStableBlindIndexKeyVersion(input.workspaceKeys),
          nameConflictId,
          nameConflictCiphertext: nameConflictEnvelope.ciphertext,
          nameConflictCiphertextHash: nameConflictEnvelope.ciphertextHash,
        } : {}),
        blobRefs: prepared.blobRefs,
        resourceObjectIds: prepared.resources.map(resource => resource.resourceId),
        keyVersion: input.keyVersion, ...envelope,
      }
    }
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command })
  }
}

async function flushSyncOutbox(input: RuntimeInput): Promise<{ count: number, conflicts: string[] }> {
  let count = 0
  const conflicts: string[] = []
  while (true) {
    const entries = await listSyncOutbox(input.syncScopeId, 100)
    if (entries.length === 0) break
    const commands = entries.map(entry => JSON.parse(entry.commandJson) as SyncCommand)
    const results = await pushSyncCommands({
      baseUrl: input.baseUrl, accessToken: input.session.accessToken,
      workspaceId: input.workspaceId, commands,
      ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
    })
    for (const result of results) {
      const outbox = entries.find(entry => entry.commandId === result.commandId)
      const command = commands.find(item => item.commandId === result.commandId)
      if (!outbox || !command) continue
      if (result.status === 'rejected') {
        if (result.code === 'command_id_reused') {
          if (await replaceReusedSyncCommand(input.syncScopeId, outbox)) continue
        }
        if (command.type === 'delete-object' && result.code === 'revision_conflict'
          && result.revision
          && await rebaseSyncDeleteCommand(input.syncScopeId, outbox, result.revision)) {
          continue
        }
        if (result.code === 'revision_conflict') {
          // A stale immutable command cannot become valid by retrying it. Drop
          // it without surfacing a permanent block; staged local intent is
          // reconstructed after the authoritative remote revision is pulled.
          await completeSyncCommand(input.syncScopeId, result.commandId)
          continue
        }
        if (command.type === 'create-conflict' && result.code === 'conflict_id_reused') {
          // The server already owns this deterministic conflict ID. Encrypted
          // payloads use random nonces, so rebuilding the same semantic
          // conflict can legitimately produce different ciphertext. Retire
          // this command and immediately requeue the local conflict under a
          // fresh derived identity instead of permanently blocking sync.
          await completeSyncCommand(input.syncScopeId, result.commandId)
          await requeueOrphanedLocalConflicts(input)
          continue
        }
        if (command.type === 'create-conflict' && result.code === 'conflict_changed') {
          // Conflict creation is conditional on the object's old lifecycle or
          // document revision. The next pull/reconciliation pass recreates it
          // from the durable local conflict using the current remote revision.
          await completeSyncCommand(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        if (command.type === 'commit-checkpoint' && result.code === 'checkpoint_not_current') {
          // Checkpoints are immutable encrypted commands. Retrying one with an
          // obsolete coverage sequence can never succeed; a later session
          // checkpoint will be generated from the converged Yjs state.
          await completeSyncCommand(input.syncScopeId, result.commandId)
          continue
        }
        if (command.type === 'resolve-conflict' && result.code === 'required_command_not_applied') {
          await completeSyncCommand(input.syncScopeId, result.commandId)
          continue
        }
        if (command.type === 'resolve-conflict'
          && (result.code === 'conflict_changed' || result.code === 'same_name_still_conflicts')) {
          await completeSyncCommand(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        await failSyncCommand(input.syncScopeId, result.commandId,
          result.code ?? 'command_rejected', result.retryable !== true)
        // Durable command responses do not have an HTTP status, but these
        // codes carry the same account-action contract as a route response.
        // Keeping just one command blocked while the background worker keeps
        // flushing the rest creates a hot retry loop and hides the account
        // state that must be resolved first. The outbox remains intact; the
        // background coordinator turns this into a visible paused state.
        if (isActionRequiredCommandCode(result.code)) {
          throw new NoteGenServerRequestError(
            `同步需要处理账号状态（${result.code}）`, 409, result.code, false, result.details,
          )
        }
        continue
      }
      if (result.status === 'conflict' && result.code !== 'delete_edit_conflict') {
        if (command.type === 'delete-object' && result.code === 'revision_conflict'
          && result.revision
          && await rebaseSyncDeleteCommand(input.syncScopeId, outbox, result.revision)) {
          // Lifecycle revisions are optimistic concurrency guards. Rebase the
          // deletion automatically, while retaining expectedDocumentSequence
          // so a real delete-vs-edit race still produces a resolvable conflict.
          continue
        }
        if (command.type === 'upsert-object' && result.code === 'revision_conflict') {
          // The corresponding remote object event is durable and will create
          // the typed local conflict without discarding the staged local value.
          await completeSyncCommand(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        if (command.type === 'resolve-conflict'
          && (result.code === 'conflict_changed' || result.code === 'same_name_still_conflicts')) {
          await completeSyncCommand(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        if (command.type === 'create-conflict' && result.code === 'conflict_changed') {
          await completeSyncCommand(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        await failSyncCommand(input.syncScopeId, result.commandId,
          result.code ?? 'command_conflict', true)
        conflicts.push(command.objectId ?? result.commandId)
        continue
      }
      if (command.type === 'create-conflict' && result.status === 'applied'
        && result.sequence && result.conflictId) {
        const localConflict = await getSyncConflict(input.syncScopeId, result.conflictId)
        if (localConflict && localConflict.createdSequence === '0') {
          await upsertSyncConflict({
            ...localConflict,
            createdSequence: result.sequence,
          })
        }
      }
      await completeSyncCommand(input.syncScopeId, result.commandId)
      await completeSyncMutation(input.syncScopeId, result.commandId)
      if (Array.isArray(command.mutationIds)) {
        for (const mutationId of command.mutationIds) {
          if (typeof mutationId === 'string') await completeSyncMutation(input.syncScopeId, mutationId)
        }
      }
      const stagedOperation = command.objectId
        ? await getNoteGenServerOutboxForObject(input.syncScopeId, command.objectId)
        : null
      const mutationIds = Array.isArray(command.mutationIds)
        ? command.mutationIds.filter((value): value is string => typeof value === 'string')
        : []
      if (stagedOperation && (
        stagedOperation.operationId === result.commandId
        || mutationIds.includes(stagedOperation.operationId)
      )) {
        if (result.status === 'conflict') {
          await deleteNoteGenServerOutboxEntry(stagedOperation.id, stagedOperation.operationId)
        } else if (result.revision) {
          await completeNoteGenServerOutboxEntry({
            entryId: stagedOperation.id, operationId: stagedOperation.operationId, workspaceId: input.syncScopeId,
            objectId: stagedOperation.objectId, relativePath: stagedOperation.relativePath, kind: stagedOperation.kind,
            action: stagedOperation.action, revision: result.revision, contentHash: stagedOperation.contentHash,
          })
        }
      }
      count += 1
    }
    const remaining = await listSyncOutbox(input.syncScopeId, 100)
    if (entries.length === remaining.length
      && entries.every((entry, index) => entry.commandId === remaining[index]?.commandId)) break
  }
  return { count, conflicts }
}

function isActionRequiredCommandCode(code: string | undefined): boolean {
  return code !== undefined && [
    'email_verification_required', 'policy_acceptance_required', 'policy_reacceptance_required',
    'risk_challenge_required', 'risk_temporarily_locked', 'risk_review_required', 'risk_denied',
    'quota_exceeded', 'device_limit_exceeded', 'workspace_limit_exceeded', 'account_read_only', 'credential_review_required',
    'server_maintenance', 'cursor_expired', 'sync_epoch_changed', 'instance_auth_epoch_invalid',
  ].includes(code)
}

async function enqueuePreparedAssetResource(
  input: RuntimeInput,
  ownerOperationId: string,
  resource: NoteGenServerPreparedAssetResource,
): Promise<void> {
  const entity = await getSyncEntity(input.syncScopeId, resource.resourceId)
  if (!entity) throw new Error(`附件资源缺少本地身份映射：${resource.localPath}`)
  const existing = parseJson(entity.basePayloadJson) as {
    contentHash?: string
    blobId?: string
    blobKeyVersion?: number
  } | null
  if (entity.lifecycleRevision !== '0' && existing?.contentHash === resource.contentHash
    && existing.blobKeyVersion === (resource.blobKeyVersion ?? input.keyVersion)) {
    return
  }
  const payload = {
    schemaVersion: 2,
    type: 'asset',
    resourceId: resource.resourceId,
    localPath: resource.localPath,
    contentHash: resource.contentHash,
    size: resource.size,
    blobId: resource.blobId,
    blobKeyVersion: resource.blobKeyVersion ?? input.keyVersion,
    ...(resource.scope === 'workspace' ? { scope: resource.scope } : {}),
    assets: [{
      resourceId: resource.resourceId,
      localPath: resource.localPath,
      contentHash: resource.contentHash,
      size: resource.size,
      blobId: resource.blobId,
      blobKeyVersion: resource.blobKeyVersion ?? input.keyVersion,
      ...(resource.scope === 'workspace' ? { scope: resource.scope } : {}),
    }],
  }
  const envelope = await encryptSyncPayload(input.workspaceKey, payload, {
    workspaceId: input.workspaceId,
    objectId: resource.resourceId,
    kind: 'asset',
    keyVersion: input.keyVersion,
    purpose: 'object',
    identity: resource.resourceId,
  })
  const commandId = await createDeterministicServerObjectId(
    input.workspaceId, 'asset-command', `${ownerOperationId}:${resource.resourceId}`,
  )
  await enqueueSyncCommand({
    scopeId: input.syncScopeId,
    command: {
      commandId,
      type: 'upsert-object',
      objectId: resource.resourceId,
      kind: 'asset',
      parentObjectId: null,
      nameCiphertext: envelope.ciphertext,
      baseRevision: entity.lifecycleRevision === '0' ? null : entity.lifecycleRevision,
      blobRefs: [resource.blobId],
      keyVersion: input.keyVersion,
      ...envelope,
    },
  })
  await setSyncTransfer({
    scopeId: input.syncScopeId,
    transferId: `resource-upload:${ownerOperationId}:${resource.resourceId}`,
    objectId: resource.resourceId,
    blobId: resource.blobId,
    direction: 'upload',
    state: 'complete',
    completedBytes: resource.size,
    totalBytes: resource.size,
  })
}

async function receiveEvents(input: RuntimeInput): Promise<number> {
  const health = await getSyncHealthSnapshot(input.syncScopeId)
  let after = health.receivedCursor
  let received = 0
  while (true) {
    let page: Awaited<ReturnType<typeof pullSyncEvents>>
    try {
      page = await pullSyncEvents({
        baseUrl: input.baseUrl, accessToken: input.session.accessToken,
        workspaceId: input.workspaceId, after,
        ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
      })
    } catch (error) {
      if (error instanceof NoteGenServerRequestError && error.code === 'cursor_expired') {
        await resetSyncForServerEpoch(input.syncScopeId)
        await ensureBootstrap(input, 'cursor-expired')
        return received
      }
      throw error
    }
    for (const event of page.events) await storeSyncEvent(input.syncScopeId, event)
    after = page.nextCursor
    received += page.events.length
    await updateSyncCursor(input.syncScopeId, after, page.latestSequence)
    if (!page.hasMore) break
  }
  return received
}

async function applyInbox(input: RuntimeInput): Promise<{ count: number, conflicts: string[] }> {
  let count = 0
  const conflicts: string[] = []
  let rows = await listUnappliedSyncEvents(input.syncScopeId)
  while (rows.length > 0) {
    const deferred = [] as typeof rows
    const deferredReferences = new Map<string, Array<{ kind: 'tag' | 'mark', id: string }>>()
    let appliedThisPass = 0
    for (const row of rows) {
      const event = JSON.parse(row.eventJson) as SyncEvent
      try {
        await beginSyncEventApply(input.syncScopeId, event.eventId, row.eventJson)
        const conflict = await applyEvent(input, event)
        if (conflict) conflicts.push(conflict)
        await completeSyncEvent(input.syncScopeId, event.eventId)
        count += 1
        appliedThisPass += 1
      } catch (error) {
        const missingReferences = getMissingStructuredReferences(error)
        if (missingReferences) {
          await deferSyncEvent(input.syncScopeId, event.eventId, errorMessage(error))
          deferred.push(row)
          deferredReferences.set(event.eventId, missingReferences)
          continue
        }
        await failSyncEvent(input.syncScopeId, event.eventId, errorMessage(error))
        if (error instanceof SyncKeyMissingError) throw error
      }
    }
    if (deferred.length === 0) break
    if (appliedThisPass === 0) {
      let recoveredReference = false
      for (const references of deferredReferences.values()) {
        for (const reference of references) {
          if (reference.kind !== 'tag') continue
          recoveredReference = await import('@/db/tags').then(module => (
            module.recoverMissingTagReference(reference.id)
          )) || recoveredReference
        }
      }
      if (!recoveredReference) break
    }
    rows = deferred
  }
  return { count, conflicts }
}

function getMissingStructuredReferences(
  error: unknown,
): Array<{ kind: 'tag' | 'mark', id: string }> | null {
  if (!error || typeof error !== 'object'
    || (error as { code?: unknown }).code !== 'note_gen_server_missing_reference') return null
  const references = (error as { references?: unknown }).references
  if (!Array.isArray(references)) return null
  const valid = references.filter((reference): reference is { kind: 'tag' | 'mark', id: string } => (
    Boolean(reference) && typeof reference === 'object'
      && ((reference as { kind?: unknown }).kind === 'tag' || (reference as { kind?: unknown }).kind === 'mark')
      && typeof (reference as { id?: unknown }).id === 'string'
  ))
  return valid.length > 0 ? valid : null
}

async function applyEvent(input: RuntimeInput, event: SyncEvent): Promise<string | null> {
  if (event.type === 'document.updated' || event.type === 'document.checkpointed') {
    if (!event.objectId || !event.documentId || !event.ciphertext || !event.keyVersion) return null
    const kind = String(event.metadata.kind ?? 'note')
    const identity = event.type === 'document.updated'
      ? String(event.metadata.updateId) : String(event.metadata.checkpointId)
    const key = input.workspaceKeys.get(event.keyVersion)
    if (!key) throw new SyncKeyMissingError(event.keyVersion)
    const update = await decryptSyncPayload<Uint8Array>(key, event.ciphertext, {
      workspaceId: input.workspaceId, objectId: event.objectId, kind,
      keyVersion: event.keyVersion, purpose: event.type === 'document.updated' ? 'update' : 'checkpoint', identity,
    }, true)
    emitter.emit('note-gen-server-document-update', {
      documentId: event.documentId, update, checkpoint: event.type === 'document.checkpointed',
    })
    const entity = await getSyncEntity(input.syncScopeId, event.objectId)
    const updatedEntity = entity ? { ...entity, documentId: event.documentId,
      documentSequence: event.documentSequence ?? entity.documentSequence } : null
    if (updatedEntity) await upsertSyncEntity(updatedEntity)
    const localDocument = await getLocalSyncDocument(input.syncScopeId, event.documentId)
    await upsertLocalSyncDocument({
      scopeId: input.syncScopeId, documentId: event.documentId, objectId: event.objectId,
      kind, latestDocumentSequence: event.documentSequence ?? localDocument?.latestDocumentSequence ?? '0',
      checkpointDocumentSequence: event.type === 'document.checkpointed'
        ? event.documentSequence ?? '0' : localDocument?.checkpointDocumentSequence ?? '0',
      checkpointId: event.type === 'document.checkpointed' ? identity : localDocument?.checkpointId ?? null,
      checkpointKeyVersion: event.type === 'document.checkpointed' ? event.keyVersion : localDocument?.checkpointKeyVersion ?? null,
      checkpointCiphertext: event.type === 'document.checkpointed' ? event.ciphertext : localDocument?.checkpointCiphertext ?? null,
      checkpointCiphertextHash: event.type === 'document.checkpointed' ? event.ciphertextHash : localDocument?.checkpointCiphertextHash ?? null,
    })
    if (updatedEntity && updatedEntity.basePayloadJson
      && (parseJson(updatedEntity.basePayloadJson) as { type?: string } | null)?.type === 'crdt-object') {
      await materializeCrdtEntity(input, updatedEntity, event.sourceDeviceId !== input.session.deviceId)
    }
    return null
  }
  if (event.type === 'conflict.created') return await applyConflictCreated(input, event)
  if (event.type === 'conflict.resolved') {
    const conflictId = String(event.metadata.conflictId ?? '')
    if (conflictId) {
      const localConflict = await getSyncConflict(input.syncScopeId, conflictId)
      if (localConflict) {
        const payload = parseJson(localConflict.payloadJson) as {
          type?: string, path?: string, deletionRequestedLocally?: boolean
        } | null
        if (payload?.path && payload.deletionRequestedLocally !== true
          && (payload.type === 'delete-vs-edit' || payload.type === 'delete-subtree')) {
          if (localConflict.kind === 'note') {
            await removeWorkspaceFile(payload.path)
            emitter.emit('sync-content-updated', { path: payload.path, content: '' })
          } else if (localConflict.kind === 'folder') {
            const options = await getFilePathOptions(payload.path)
            const present = await exists(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
            if (present) await remove(options.path, options.baseDir
              ? { baseDir: options.baseDir, recursive: true } : { recursive: true })
          }
        }
      }
      await resolveLocalSyncConflict(input.syncScopeId, conflictId)
      if (event.objectId) {
        const stale = await getNoteGenServerOutboxForObject(input.syncScopeId, event.objectId)
        if (stale) await deleteNoteGenServerOutboxEntry(stale.id, stale.operationId)
      }
      emitter.emit('note-gen-server-conflict-resolved', { conflictId })
    }
    return null
  }
  if (event.type !== 'object.upserted' && event.type !== 'object.deleted') return null
  if (!event.objectId || !event.ciphertext || !event.keyVersion) throw new Error('对象事件缺少密文')
  const kind = String(event.metadata.kind) as SyncObjectKind
  const key = input.workspaceKeys.get(event.keyVersion)
  if (!key) throw new SyncKeyMissingError(event.keyVersion)
  const payload = await decryptSyncPayload<unknown>(key, event.ciphertext, {
    workspaceId: input.workspaceId, objectId: event.objectId, kind,
    keyVersion: event.keyVersion, purpose: 'object', identity: event.objectId,
  })
  return await materializeObject(input, event, kind, payload)
}

async function applyConflictCreated(input: RuntimeInput, event: SyncEvent): Promise<string | null> {
  if (!event.objectId || !event.ciphertext || !event.keyVersion) throw new Error('冲突事件缺少密文')
  const conflictId = String(event.metadata.conflictId ?? '')
  const kind = String(event.metadata.kind ?? 'note')
  const conflictType = String(event.metadata.conflictType ?? 'content')
  const existing = conflictId ? await getSyncConflict(input.syncScopeId, conflictId) : null
  if (existing && existing.objectId === event.objectId
    && existing.kind === kind && existing.type === conflictType) {
    // Older servers could emit the same durable conflict again when a client
    // retried with a fresh command ID. Advance the inbox cursor without
    // decrypting, reopening, or notifying about the same conflict hundreds of times.
    return event.objectId
  }
  const key = input.workspaceKeys.get(event.keyVersion)
  if (!key || !conflictId) throw new Error('冲突事件无法解密')
  const payload = await decryptSyncPayload(key, event.ciphertext, {
    workspaceId: input.workspaceId, objectId: event.objectId, kind,
    keyVersion: event.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await upsertSyncConflict({
    scopeId: input.syncScopeId, conflictId, objectId: event.objectId, kind,
    type: conflictType, status: 'unresolved',
    createdSequence: event.sequence, payloadJson: JSON.stringify(payload),
    createdAt: Date.parse(event.createdAt) || Date.now(), resolvedAt: null,
  })
  emitter.emit('note-gen-server-conflict-created', { conflictId, objectId: event.objectId, kind })
  return event.objectId
}

async function materializeObject(
  input: RuntimeInput, event: SyncEvent, kind: SyncObjectKind, payload: unknown,
): Promise<string | null> {
  const revision = String(event.metadata.revision ?? '0')
  const current = await getSyncEntity(input.syncScopeId, event.objectId!)
  const logicalKey = kind === 'asset' && payload && typeof payload === 'object'
    ? assetEntityLocalKey(
        typeof (payload as Record<string, unknown>).localPath === 'string'
          ? (payload as Record<string, unknown>).localPath as string
          : event.objectId!,
        (payload as Record<string, unknown>).scope === 'workspace' ? 'workspace' : 'appData',
        event.objectId!,
      )
    : logicalKeyForPayload(payload, current?.localKey ?? event.objectId!)
  const localKeyOwner = await getSyncEntityByLocalKey(input.syncScopeId, logicalKey)
  const identityCollision = localKeyOwner?.objectId !== event.objectId ? localKeyOwner : null
  const entity: SyncEntity = current ?? {
    scopeId: input.syncScopeId, objectId: event.objectId!, kind,
    localKey: identityCollision ? `__sync_pending__/${event.objectId!}` : logicalKey,
    parentObjectId: null, name: logicalKey.split('/').at(-1) ?? logicalKey,
    lifecycleRevision: '0', documentId: null, documentSequence: '0',
    materializedHash: null, basePayloadJson: null, deleted: 0,
  }
  const deleted = event.type === 'object.deleted'
  const resolvingConflict = typeof event.metadata.conflictId === 'string'
  const blobRefs = Array.isArray(event.metadata.blobRefs) ? event.metadata.blobRefs as string[] : []
  const assetBinding = getAssetBinding(payload)
  if (assetBinding) {
    await setSyncTransfer({
      scopeId: input.syncScopeId,
      transferId: `asset-binding:${event.objectId}:${assetBinding.operationId}`,
      objectId: event.objectId!, direction: 'download',
      state: assetBinding.state === 'failed' ? 'failed'
        : assetBinding.state === 'ready'
          ? blobRefs.length > 0 ? 'running' : 'complete'
          : 'pending',
      ...(assetBinding.state === 'failed'
        ? { error: assetBinding.error || '远端设备附件上传失败' } : {}),
    })
  }
  if (!deleted && blobRefs.length > 0) {
    const transferId = `object-download:${event.eventId}`
    await setSyncTransfer({
      scopeId: input.syncScopeId, transferId, objectId: event.objectId!,
      direction: 'download', state: 'running',
    })
    try {
      await restoreNoteGenServerPayloadAssets({
        payload, blobRefs, baseUrl: input.baseUrl, accessToken: input.session.accessToken,
        workspaceId: input.workspaceId, workspaceKey: input.workspaceKeys.get(event.keyVersion!)!,
        preserveLocalOnConflict: kind === 'asset',
        replaceExpectedContentHash: kind === 'asset'
          ? (parseJson(current?.basePayloadJson ?? null) as { contentHash?: string } | null)?.contentHash
          : undefined,
        onTransferProgress: async progress => {
          input.onTransferProgress?.(progress)
          await setSyncTransfer({
            scopeId: input.syncScopeId, transferId: `blob-download:${progress.blobId}`,
            objectId: event.objectId!, blobId: progress.blobId, direction: 'download',
            state: progress.completedBytes >= progress.totalBytes ? 'complete' : 'running',
            completedBytes: progress.completedBytes, totalBytes: progress.totalBytes,
          })
        },
      })
      await setSyncTransfer({
        scopeId: input.syncScopeId, transferId, objectId: event.objectId!,
        direction: 'download', state: 'complete',
      })
      if (kind === 'asset') {
        await completeSyncTransfersForObject(input.syncScopeId, event.objectId!)
      }
      if (assetBinding) {
        await setSyncTransfer({
          scopeId: input.syncScopeId,
          transferId: `asset-binding:${event.objectId}:${assetBinding.operationId}`,
          objectId: event.objectId!, direction: 'download', state: 'complete',
        })
      }
    } catch (error) {
      await setSyncTransfer({
        scopeId: input.syncScopeId, transferId, objectId: event.objectId!,
        direction: 'download', state: 'failed', error: errorMessage(error),
      })
      if (assetBinding) {
        await setSyncTransfer({
          scopeId: input.syncScopeId,
          transferId: `asset-binding:${event.objectId}:${assetBinding.operationId}`,
          objectId: event.objectId!, direction: 'download', state: 'failed',
          error: errorMessage(error),
        })
      }
      if (kind === 'asset' && error instanceof NoteGenServerAssetLocalConflictError) {
        const conflictId = await queueContentConflict(input, entity, revision, {
          schemaVersion: 2,
          type: 'asset-content',
          resourceId: event.objectId!,
          path: error.localPath,
          localContentHash: error.localContentHash,
          remoteContentHash: error.remoteContentHash,
          remote: payload,
        }, 'asset-content')
        await upsertSyncEntity({
          ...entity,
          kind,
          localKey: logicalKey,
          name: `${(payload as Record<string, unknown>).scope === 'workspace' ? 'workspace' : 'appData'}:${error.localPath}`,
          lifecycleRevision: revision,
          basePayloadJson: JSON.stringify(payload),
        })
        await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
        return conflictId
      }
      throw error
    }
  }
  const resourceRefs = kind === 'asset' || deleted ? []
    : getNoteGenServerPayloadResourceReferences(payload).map(reference => ({
        resourceObjectId: reference.resourceId,
        localPath: reference.localPath,
      }))
  const crdtLifecycle = payload && typeof payload === 'object'
    && (payload as Record<string, unknown>).type === 'crdt-object'
  if (deleted && identityCollision) {
    // The deleted event belongs to a superseded object identity. Another
    // active entity already owns this logical key, so applying the tombstone
    // to business data would delete the current record/canvas/note and make
    // an open mobile editor navigate away after its own successful edit.
    // Retire only the event's identity and leave the active owner untouched.
    const staleOperation = await getNoteGenServerOutboxForObject(
      input.syncScopeId, event.objectId!,
    )
    if (staleOperation) {
      await deleteNoteGenServerOutboxEntry(staleOperation.id, staleOperation.operationId)
    }
    await deleteNoteGenServerSyncObject(input.syncScopeId, event.objectId!)
    await replaceSyncResourceRefs({
      scopeId: input.syncScopeId, ownerObjectId: event.objectId!, resources: [],
    })
    await upsertSyncEntity({
      ...entity,
      kind,
      localKey: `__sync_replaced__/${event.objectId!}`,
      lifecycleRevision: revision,
      parentObjectId: event.metadata.parentObjectId === null
        ? null : typeof event.metadata.parentObjectId === 'string'
          ? event.metadata.parentObjectId : entity.parentObjectId,
      basePayloadJson: JSON.stringify(payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), retiredIdentity: true }
        : { retiredIdentity: true }),
      deleted: 1,
    })
    return null
  }
  if (crdtLifecycle) {
    // CRDT lifecycle envelopes only establish object/document identity. The
    // Markdown content arrives separately as durable Yjs updates.
  } else if (kind === 'note') {
    const note = payload as { relativePath?: string, content?: string, assets?: unknown[] }
    const remotePath = await ensureSafeWorkspaceRelativePath(note.relativePath ?? logicalKey)
    const localPath = resolvingConflict
      ? remotePath
      : (identityCollision?.localKey ?? entity.localKey) || remotePath
    const caseCollisionPath = await findWorkspaceCaseCollision(remotePath)
    if (!resolvingConflict && caseCollisionPath) {
      const conflictId = await queueContentConflict(input, entity, revision, {
        schemaVersion: 2,
        type: 'same-name',
        objectId: entity.objectId,
        parentObjectId: entity.parentObjectId,
        path: remotePath,
        localPath: caseCollisionPath,
        remotePath,
        name: remotePath.split('/').at(-1) ?? remotePath,
      }, 'same-name')
      await upsertSyncEntity({
        ...entity,
        lifecycleRevision: revision,
        basePayloadJson: JSON.stringify(payload),
      })
      await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
      return conflictId
    }
    const local = await readWorkspaceFile(localPath)
    const base = parseJson(entity.basePayloadJson) as { content?: string, relativePath?: string } | null
    if (!resolvingConflict && base?.relativePath && localPath !== base.relativePath && remotePath !== base.relativePath && localPath !== remotePath) {
      const conflictId = await queueContentConflict(input, entity, revision, {
        schemaVersion: 2, type: 'concurrent-rename', path: localPath,
        localPath, remotePath, basePath: base.relativePath,
        base: base.content ?? '', local: local ?? '', remote: note.content ?? '',
      }, 'concurrent-rename')
      await upsertSyncEntity({ ...entity, lifecycleRevision: revision, basePayloadJson: JSON.stringify(payload) })
      await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
      return conflictId
    }
    const path = base?.relativePath && localPath !== base.relativePath && remotePath === base.relativePath
      ? localPath : remotePath
    if (!resolvingConflict && local !== null && ((!base && local !== note.content) || (base && local !== base.content && local !== note.content))) {
      const conflictType = base ? 'markdown-three-way' : 'initial-import'
      const conflictId = await queueContentConflict(input, entity, revision, {
        schemaVersion: 2, type: deleted ? 'delete-vs-edit' : conflictType, path,
        base: base?.content ?? '', local, remote: deleted ? null : note.content ?? '',
      }, deleted ? 'delete-vs-edit' : conflictType)
      await upsertSyncEntity({ ...entity, kind,
        localKey: identityCollision ? entity.localKey : path, lifecycleRevision: revision,
        basePayloadJson: JSON.stringify(payload), deleted: 0 })
      await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
      return conflictId
    }
    if (!deleted) {
      await import('@/stores/article').then(module => module.acceptArticlePathFromSync(path))
      await writeWorkspaceFile(path, note.content ?? '')
      if (localPath !== path && local !== null) await removeWorkspaceFile(localPath)
      emitter.emit('sync-content-updated', { path, content: note.content ?? '' })
    } else {
      await import('@/stores/article').then(async module => {
        module.discardArticlePathFromSync(path)
        await module.default.getState().cleanTabsByDeletedFile(path)
      })
      if (local !== null) await removeWorkspaceFile(path)
      emitter.emit('sync-object-deleted', { kind: 'note', path })
    }
  } else if (kind === 'folder') {
    const path = await ensureSafeWorkspaceRelativePath(logicalKey)
    const options = await getFilePathOptions(path)
    if (!deleted) {
      await import('@/stores/article').then(module => module.acceptArticlePathFromSync(path, true))
      const previousPath = entity.localKey
      const previousOptions = await getFilePathOptions(previousPath)
      const [previousPresent, targetPresent, targetEntity] = await Promise.all([
        previousPath === path ? Promise.resolve(false)
          : exists(previousOptions.path, previousOptions.baseDir ? { baseDir: previousOptions.baseDir } : undefined),
        exists(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined),
        getSyncEntityByLocalKey(input.syncScopeId, path),
      ])
      const folderIdentityCollision = targetEntity !== null && targetEntity.objectId !== entity.objectId
      if (!resolvingConflict && ((previousPresent && targetPresent) || (!current && targetPresent)
        || folderIdentityCollision)) {
        const remoteParentObjectId = event.metadata.parentObjectId === null
          ? null : typeof event.metadata.parentObjectId === 'string'
            ? event.metadata.parentObjectId : entity.parentObjectId
        const conflictEntity = {
          ...entity,
          parentObjectId: remoteParentObjectId,
          ...(!current ? { localKey: `__sync_pending__/${entity.objectId}` } : {}),
        }
        const conflictId = await queueContentConflict(input, conflictEntity, revision, {
          schemaVersion: 2, type: 'same-name', objectId: entity.objectId,
          parentObjectId: remoteParentObjectId,
          path, name: path.split('/').at(-1) ?? path,
        }, 'same-name')
        await upsertSyncEntity({ ...conflictEntity, lifecycleRevision: revision,
          basePayloadJson: JSON.stringify(payload) })
        await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
        return conflictId
      }
      if (resolvingConflict && folderIdentityCollision) {
        await retireSyncEntityIdentity(input.syncScopeId, targetEntity.objectId, entity.objectId)
      }
      if (previousPresent) {
        const parentPath = path.split('/').slice(0, -1).join('/')
        if (parentPath) {
          const parentOptions = await getFilePathOptions(parentPath)
          await mkdir(parentOptions.path, {
            ...(parentOptions.baseDir ? { baseDir: parentOptions.baseDir } : {}), recursive: true,
          })
        }
        await rename(previousOptions.path, options.path,
          previousOptions.baseDir || options.baseDir ? {
            ...(previousOptions.baseDir ? { oldPathBaseDir: previousOptions.baseDir } : {}),
            ...(options.baseDir ? { newPathBaseDir: options.baseDir } : {}),
          } : undefined)
        await import('@/db/note-gen-server-sync-index').then(module => (
          module.moveSyncEntityLocalKey(input.syncScopeId, previousPath, path)
        ))
      } else if (!targetPresent) {
        await mkdir(options.path, { ...(options.baseDir ? { baseDir: options.baseDir } : {}), recursive: true })
      }
    } else {
      await import('@/stores/article').then(async module => {
        module.discardArticlePathFromSync(path, true)
        await module.default.getState().cleanTabsByDeletedFolder(path)
      })
      const present = await exists(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
      if (present) {
        const children = await readDir(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
        if (children.length > 0 && !resolvingConflict) {
          const conflictId = await queueContentConflict(input, entity, revision, {
            schemaVersion: 2, type: 'delete-subtree', path, childNames: children.map(child => child.name),
            base: entity.basePayloadJson, local: { path, childCount: children.length }, remote: null,
          }, 'delete-subtree')
          await upsertSyncEntity({ ...entity, lifecycleRevision: revision, basePayloadJson: JSON.stringify(payload) })
          await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
          return conflictId
        }
        await remove(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
      }
      emitter.emit('sync-object-deleted', { kind: 'folder', path })
    }
  } else {
    const missingReferences = deleted ? [] : await findMissingStructuredReferences(kind, payload)
    if (missingReferences.length > 0) {
      const { NoteGenServerMissingReferenceError } = await import('./note-gen-server-domains')
      throw new NoteGenServerMissingReferenceError(missingReferences)
    }
    const pending = await getNoteGenServerOutboxForObject(
      input.syncScopeId, identityCollision?.objectId ?? event.objectId!,
    )
    const applyingOwnAssetBinding = pending?.operationId === assetBinding?.operationId
    if (!applyingOwnAssetBinding && pending?.payloadJson
      && pending.payloadJson !== JSON.stringify(payload)) {
      const conflictId = await queueContentConflict(input, entity, revision, {
        schemaVersion: 2, type: 'structured-concurrent', logicalKey,
        base: parseJson(entity.basePayloadJson), local: JSON.parse(pending.payloadJson), remote: payload,
      }, 'structured-concurrent')
      await upsertSyncEntity({ ...entity, kind,
        localKey: identityCollision ? entity.localKey : logicalKey, lifecycleRevision: revision,
        basePayloadJson: JSON.stringify(payload) })
      await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
      return conflictId
    }
    const domains = await import('./note-gen-server-domains')
    const parentObjectId = event.metadata.parentObjectId === null
      ? null : typeof event.metadata.parentObjectId === 'string'
        ? event.metadata.parentObjectId : entity.parentObjectId
    if (identityCollision) {
      await retireSyncEntityIdentity(input.syncScopeId, identityCollision.objectId, entity.objectId)
    }
    const atomicApplied = await domains.applyNoteGenServerDomainChangeAtomic({
      syncScopeId: input.syncScopeId, eventId: event.eventId,
      entity: { ...entity, kind, parentObjectId }, revision, payload, deleted, resourceRefs,
    })
    if (atomicApplied) {
      if (event.sourceDeviceId !== 'bootstrap') {
        await domains.refreshNoteGenServerAtomicDomainView(kind)
      }
      if (!deleted && payload && typeof payload === 'object') {
        await domains.ensureNoteGenServerStructuredObjectFromPayload({
          workspaceId: input.workspaceId, syncScopeId: input.syncScopeId,
          objectId: event.objectId!, kind, payload,
        })
      }
      return null
    }
    await domains.applyNoteGenServerDomainChange({
      syncScopeId: input.syncScopeId, workspaceId: input.workspaceId, objectId: event.objectId!,
      kind, revision, payload, deleted, stableIdentity: true,
      refreshView: event.sourceDeviceId !== 'bootstrap',
    })
  }
  if (kind !== 'asset') {
    await replaceSyncResourceRefs({
      scopeId: input.syncScopeId, ownerObjectId: event.objectId!, resources: resourceRefs,
    })
  }
  if (identityCollision) {
    await retireSyncEntityIdentity(input.syncScopeId, identityCollision.objectId, entity.objectId)
  }
  await upsertSyncEntity({ ...entity, kind, localKey: logicalKey,
    ...(kind === 'asset' && payload && typeof payload === 'object'
      ? { name: `${(payload as Record<string, unknown>).scope === 'workspace' ? 'workspace' : 'appData'}:${
          typeof (payload as Record<string, unknown>).localPath === 'string'
            ? (payload as Record<string, unknown>).localPath : event.objectId!}` }
      : {}),
    lifecycleRevision: revision,
    parentObjectId: event.metadata.parentObjectId === null
      ? null : typeof event.metadata.parentObjectId === 'string'
        ? event.metadata.parentObjectId : entity.parentObjectId,
    ...(event.documentId ? {
      documentId: event.documentId,
      documentSequence: event.documentSequence ?? entity.documentSequence,
    } : {}),
    basePayloadJson: JSON.stringify(payload), deleted: deleted ? 1 : 0 })
  if (!deleted && kind !== 'note' && kind !== 'folder'
    && payload && typeof payload === 'object' && (payload as Record<string, unknown>).type !== 'crdt-object') {
    await import('./note-gen-server-domains').then(module => module.ensureNoteGenServerStructuredObjectFromPayload({
      workspaceId: input.workspaceId, syncScopeId: input.syncScopeId,
      objectId: event.objectId!, kind, payload,
    }))
  }
  return null
}

async function findMissingStructuredReferences(
  kind: SyncObjectKind,
  payload: unknown,
): Promise<Array<{ kind: 'tag' | 'mark', id: string }>> {
  if (!payload || typeof payload !== 'object') return []
  const value = (payload as Record<string, unknown>).value
  if (!value || typeof value !== 'object') return []
  if (kind === 'mark') {
    const tagSyncId = (value as Record<string, unknown>).tagSyncId
    if (typeof tagSyncId !== 'string' || !tagSyncId) return []
    const tag = await import('@/db/tags').then(module => module.getTagBySyncId(tagSyncId))
    return tag ? [] : [{ kind: 'tag', id: tagSyncId }]
  }
  if (kind !== 'canvas') return []
  const document = (value as Record<string, unknown>).document
  const nodes = document && typeof document === 'object'
    ? (document as Record<string, unknown>).nodes : null
  if (!Array.isArray(nodes)) return []
  const recordIds = new Set<string>()
  for (const node of nodes) {
    const data = node && typeof node === 'object' ? (node as Record<string, unknown>).data : null
    const recordSyncId = data && typeof data === 'object'
      ? (data as Record<string, unknown>).recordSyncId : null
    if (typeof recordSyncId === 'string' && recordSyncId) recordIds.add(recordSyncId)
  }
  const missing: Array<{ kind: 'mark', id: string }> = []
  for (const id of recordIds) {
    const mark = await import('@/db/marks').then(module => module.getMarkBySyncId(id))
    if (!mark) missing.push({ kind: 'mark', id })
  }
  return missing
}

async function settlePendingOperationForConflict(
  scopeId: string,
  objectId: string,
  remoteRevision: string,
): Promise<void> {
  const pending = await getNoteGenServerOutboxForObject(scopeId, objectId)
  if (!pending || pending.action !== 'upsert') return
  await completeNoteGenServerOutboxEntry({
    entryId: pending.id,
    operationId: pending.operationId,
    workspaceId: scopeId,
    objectId: pending.objectId,
    relativePath: pending.relativePath,
    kind: pending.kind,
    action: pending.action,
    revision: remoteRevision,
    contentHash: pending.contentHash,
  })
}

async function queueContentConflict(
  input: RuntimeInput, entity: SyncEntity, expectedRevision: string, payload: unknown,
  conflictType = 'markdown-three-way',
): Promise<string> {
  const conflictIdentity = [
    entity.objectId,
    expectedRevision,
    entity.documentSequence,
    conflictType,
    JSON.stringify(payload),
  ].join('\0')
  const conflictId = await createDeterministicServerObjectId(
    input.workspaceId,
    'content-conflict',
    conflictIdentity,
  )
  const commandId = await createDeterministicServerObjectId(
    input.workspaceId,
    'content-conflict-command',
    conflictIdentity,
  )
  const encrypted = await encryptSyncPayload(input.workspaceKey, payload, {
    workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
    keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
    type: 'create-conflict', commandId, conflictId, objectId: entity.objectId, kind: entity.kind,
    conflictType, expectedRevision,
    expectedDocumentSequence: entity.documentSequence, keyVersion: input.keyVersion, ...encrypted,
  } })
  await upsertSyncConflict({
    scopeId: input.syncScopeId, conflictId, objectId: entity.objectId, kind: entity.kind,
    type: conflictType, status: 'unresolved', createdSequence: '0',
    payloadJson: JSON.stringify(payload), createdAt: Date.now(), resolvedAt: null,
  })
  return conflictId
}

function logicalKeyForPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const value = payload as Record<string, unknown>
  if (typeof value.relativePath === 'string') return value.relativePath
  if (typeof value.logicalKey === 'string') return value.logicalKey
  if (typeof value.localKey === 'string') return value.localKey
  if (typeof value.key === 'string') return value.key
  if (value.value && typeof value.value === 'object') {
    const nested = value.value as Record<string, unknown>
    for (const key of ['syncId', 'id', 'path', 'name']) if (typeof nested[key] === 'string') return nested[key]
  }
  return fallback
}

async function getOrCreateAssetResourceEntity(
  scopeId: string,
  ownerObjectId: string,
  localPath: string,
  scope: 'appData' | 'workspace',
  contentHash: string,
): Promise<SyncEntity> {
  const owned = await getSyncAssetEntityForOwnerPath(scopeId, ownerObjectId, localPath)
  if (owned) return owned
  const existing = await getSyncAssetEntityByPath(scopeId, localPath, scope, contentHash)
  if (existing) return existing
  const objectId = crypto.randomUUID()
  const entity: SyncEntity = {
    scopeId,
    objectId,
    kind: 'asset',
    localKey: assetEntityLocalKey(localPath, scope, objectId),
    parentObjectId: null,
    name: `${scope}:${localPath}`,
    lifecycleRevision: '0',
    documentId: null,
    documentSequence: '0',
    materializedHash: null,
    basePayloadJson: null,
    deleted: 0,
  }
  await upsertSyncEntity(entity)
  return entity
}

function assetEntityLocalKey(
  localPath: string,
  scope: 'appData' | 'workspace',
  resourceId: string,
): string {
  const normalized = localPath.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
  return `__sync_asset__/${scope}/${normalized}#${resourceId}`
}

async function readWorkspaceFile(path: string): Promise<string | null> {
  const options = await getFilePathOptions(path)
  const workspace = await getWorkspacePath()
  const present = workspace.isCustom ? await exists(options.path) : await exists(options.path, { baseDir: options.baseDir })
  if (!present) return null
  return workspace.isCustom ? readTextFile(options.path) : readTextFile(options.path, { baseDir: options.baseDir })
}

async function findWorkspaceCaseCollision(path: string): Promise<string | null> {
  const normalized = path.replace(/\\/g, '/').normalize('NFC')
  const segments = normalized.split('/').filter(Boolean)
  const name = segments.pop()
  if (!name) return null
  const parentPath = segments.join('/')
  const parentOptions = await getFilePathOptions(parentPath)
  const parentPresent = await exists(
    parentOptions.path,
    parentOptions.baseDir ? { baseDir: parentOptions.baseDir } : undefined,
  )
  if (!parentPresent) return null
  const entries = await readDir(
    parentOptions.path,
    parentOptions.baseDir ? { baseDir: parentOptions.baseDir } : undefined,
  )
  const foldedName = name.normalize('NFKC').toLocaleLowerCase()
  const collision = entries.find(entry => (
    entry.name !== name
    && entry.name.normalize('NFKC').toLocaleLowerCase() === foldedName
  ))
  return collision ? [...segments, collision.name].join('/') : null
}

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  const options = await getFilePathOptions(path)
  await mkdir(await dirname(options.path), { ...(options.baseDir ? { baseDir: options.baseDir } : {}), recursive: true })
  const temporaryPath = `${options.path}.notegen-sync-${crypto.randomUUID()}.tmp`
  const baseOptions = options.baseDir ? { baseDir: options.baseDir } : undefined
  await writeTextFile(temporaryPath, content, { ...baseOptions, create: true, createNew: true })
  try {
    await rename(temporaryPath, options.path, options.baseDir ? {
      oldPathBaseDir: options.baseDir,
      newPathBaseDir: options.baseDir,
    } : undefined)
  } catch (error) {
    // Windows does not replace an existing destination with rename. Its
    // normal overwrite path is still safe here because the complete content
    // has already been durably staged beside the destination.
    try {
      await writeTextFile(options.path, content, { ...baseOptions, create: false, createNew: false })
    } finally {
      if (await exists(temporaryPath, baseOptions)) await remove(temporaryPath, baseOptions)
    }
    if (await readWorkspaceFile(path) !== content) throw error
  }
}

async function removeWorkspaceFile(path: string): Promise<void> {
  const options = await getFilePathOptions(path)
  const present = await exists(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
  if (!present) return
  await remove(options.path, options.baseDir ? { baseDir: options.baseDir } : undefined)
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function hasPayloadAssets(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return Array.isArray((payload as Record<string, unknown>).assets)
    && ((payload as Record<string, unknown>).assets as unknown[]).length > 0
}

function getAssetBinding(payload: unknown): {
  operationId: string
  state: 'uploading' | 'ready' | 'failed'
  error?: string
} | null {
  if (!payload || typeof payload !== 'object') return null
  const binding = (payload as Record<string, unknown>).$assetBinding
  if (!binding || typeof binding !== 'object') return null
  const value = binding as Record<string, unknown>
  if (typeof value.operationId !== 'string'
    || (value.state !== 'uploading' && value.state !== 'ready' && value.state !== 'failed')) return null
  return {
    operationId: value.operationId,
    state: value.state,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

function withAssetBinding(
  payload: unknown,
  operationId: string,
  state: 'uploading' | 'ready' | 'failed',
  error?: string,
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...(payload as Record<string, unknown>),
    $assetBinding: {
      schemaVersion: 1, operationId, state,
      ...(error ? { error: error.slice(0, 500) } : {}),
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
