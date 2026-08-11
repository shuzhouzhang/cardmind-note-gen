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
  beginSyncV2EventApply,
  completeSyncV2Command,
  completeSyncV2TransfersForObject,
  completeSyncV2Mutation,
  completeSyncV2Event,
  deferSyncV2Event,
  clearSyncV2BootstrapProgress,
  enqueueSyncV2Command,
  expireStaleSyncV2AssetBindings,
  failSyncV2Command,
  failSyncV2Event,
  getSyncV2Entity,
  getSyncV2EntityByLocalKey,
  getSyncV2Conflict,
  getSyncV2BootstrapProgress,
  getLocalSyncV2Document,
  getSyncV2HealthSnapshot,
  getSyncV2Transfer,
  getSyncV2AssetEntityByPath,
  getSyncV2AssetEntityForOwnerPath,
  hasUnresolvedSyncV2ConflictForObject,
  isSyncV2FullyConverged,
  isSyncV2BootstrapComplete,
  listSyncV2SubtreeEntities,
  listSyncV2CrdtEntitiesNeedingMaterialization,
  listSyncV2Conflicts,
  listSyncV2StructuredSnapshotsMissingLocally,
  listOrphanedLocalSyncV2Conflicts,
  listSyncV2Outbox,
  listRecoverableSyncV2Mutations,
  listRetiredSyncV2Entities,
  listUnreferencedSyncV2AssetEntities,
  listRecentActiveSyncV2TransferBlobIds,
  listUnappliedSyncV2Events,
  markSyncV2Successful,
  markSyncV2ServerConfirmed,
  markSyncV2EntityDocumentMaterialized,
  markSyncV2BootstrapComplete,
  recoverSyncV2ApplyJournal,
  rebaseSyncV2DeleteCommand,
  replaceReusedSyncV2Command,
  saveSyncV2BootstrapProgress,
  replaceSyncV2ResourceRefs,
  retireSettledSyncV2Mutations,
  retireBlockedSyncV2ConflictCommand,
  retireSyncV2EntityIdentity,
  storeSyncV2Event,
  setSyncV2Transfer,
  resolveLocalSyncV2Conflict,
  updateSyncV2Cursor,
  upsertSyncV2Conflict,
  upsertSyncV2Entity,
  upsertLocalSyncV2Document,
  type SyncV2Entity,
  type SyncV2HealthSnapshot,
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
  bootstrapSyncV2,
  createSyncV2NameBlindIndex,
  getSyncV2StableBlindIndexKey,
  getSyncV2StableBlindIndexKeyVersion,
  decryptSyncV2Payload,
  encryptSyncV2Payload,
  pullSyncV2Events,
  pushSyncV2Commands,
  type SyncV2Command,
  type SyncV2Event,
  type SyncV2BootstrapObject,
  type SyncV2ObjectKind,
} from './note-gen-server-sync-protocol'

export interface NoteGenServerSyncV2CycleResult extends SyncV2HealthSnapshot {
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
}

export class SyncV2KeyMissingError extends Error {
  constructor(readonly keyVersion: number) {
    super(`缺少 Workspace Key v${keyVersion}`)
    this.name = 'SyncV2KeyMissingError'
  }
}

let lastBlobDownloadCleanupAt = 0
const reconciledWorkspaces = new Set<string>()
const lastLocalReconciliationAt = new Map<string, number>()
const LOCAL_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const BLOB_DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000
const ORPHAN_ASSET_GRACE_MS = 7 * 24 * 60 * 60_000
const ASSET_BINDING_TIMEOUT_MS = 24 * 60 * 60_000

export function resetNoteGenServerSyncV2Reconciliation(scopeId?: string): void {
  if (scopeId) {
    reconciledWorkspaces.delete(scopeId)
    lastLocalReconciliationAt.delete(scopeId)
    return
  }
  reconciledWorkspaces.clear()
  lastLocalReconciliationAt.clear()
}

export async function runNoteGenServerSyncV2Cycle(input: RuntimeInput): Promise<NoteGenServerSyncV2CycleResult> {
  await retireStaleBlockedNoteGenServerOutbox(input.syncScopeId)
  await cleanupStaleBlobDownloads(input.syncScopeId)
  await expireStaleSyncV2AssetBindings(input.syncScopeId, Date.now() - ASSET_BINDING_TIMEOUT_MS)
  await recoverSyncV2ApplyJournal(input.syncScopeId)
  await recoverReusedSyncV2Commands(input.syncScopeId)
  // Capture the device's existing workspace before the first remote snapshot
  // can materialize over it. Stable-key collisions then become explicit
  // initial-import/structured conflicts instead of timestamp-based winners.
  if (!await isSyncV2BootstrapComplete(input.syncScopeId)) await reconcileLocalWorkspace(input)
  await ensureBootstrap(input)
  await reconcileCrdtMaterialization(input)
  await reconcileMissingStructuredSnapshots(input)
  await requeueOrphanedLocalConflicts(input)
  await recoverSyncV2Mutations(input)
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
  const pushed = await flushV2Outbox(input)
  const confirmedReceived = await receiveEvents(input)
  const confirmedApplied = await applyInbox(input)
  await resolveLegacyNoteCrdtSnapshotConflicts(input)
  await importPendingOperations(input)
  const followUpPushed = await flushV2Outbox(input)
  const finalReceived = followUpPushed.count > 0 ? await receiveEvents(input) : 0
  const finalApplied = finalReceived > 0 ? await applyInbox(input) : { count: 0, conflicts: [] }
  await retireSettledSyncV2Mutations(input.syncScopeId)
  await markSyncV2ServerConfirmed(input.syncScopeId)
  let health = await getSyncV2HealthSnapshot(input.syncScopeId)
  const staging = await getNoteGenServerSyncQueueStats(input.syncScopeId)
  health = { ...health, pendingOutbox: health.pendingOutbox + staging.pendingOutbox,
    blockedOutbox: health.blockedOutbox + staging.blockedOutbox,
    pendingInbox: health.pendingInbox + staging.storedInbox,
    failedInbox: health.failedInbox + staging.failedInbox }
  const converged = isSyncV2FullyConverged(health)
  if (converged) {
    await markSyncV2Successful(input.syncScopeId)
    health = await getSyncV2HealthSnapshot(input.syncScopeId)
  }
  return { ...health, pushed: pushed.count + followUpPushed.count,
    pulled: initialReceived + confirmedReceived + finalReceived,
    applied: initialApplied.count + confirmedApplied.count + finalApplied.count,
    conflicts: [...initialApplied.conflicts, ...pushed.conflicts, ...confirmedApplied.conflicts,
      ...followUpPushed.conflicts, ...finalApplied.conflicts], converged }
}

async function recoverReusedSyncV2Commands(scopeId: string): Promise<void> {
  const entries = await listSyncV2Outbox(scopeId, 10_000, { includeBlocked: true })
  for (const entry of entries) {
    if (entry.blocked !== 1 || !isRetiredSyncV2CommandError(entry.lastError)) continue
    // These errors mean the immutable command is stale. The accepted remote
    // revision and any durable conflict record already preserve the useful
    // state; changing the command ID merely creates an infinite retry queue.
    await completeSyncV2Command(scopeId, entry.commandId)
    try {
      const command = JSON.parse(entry.commandJson) as { mutationIds?: unknown[] }
      for (const mutationId of command.mutationIds ?? []) {
        if (typeof mutationId === 'string') await completeSyncV2Mutation(scopeId, mutationId)
      }
    } catch {
      // Malformed legacy metadata must not keep a stale command alive.
    }
  }
}

function isRetiredSyncV2CommandError(value: string | null): boolean {
  return value === 'command_id_reused'
    || value === 'revision_conflict'
    || value === 'conflict_changed'
}

async function reconcileCrdtMaterialization(input: RuntimeInput): Promise<void> {
  const entities = await listSyncV2CrdtEntitiesNeedingMaterialization(input.syncScopeId)
  for (const entity of entities) await materializeCrdtEntity(input, entity, false)
}

async function reconcileMissingStructuredSnapshots(input: RuntimeInput): Promise<void> {
  let entities = await listSyncV2StructuredSnapshotsMissingLocally(input.syncScopeId)
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
  for (const conflict of await listOrphanedLocalSyncV2Conflicts(input.syncScopeId)) {
    const entity = await getSyncV2Entity(input.syncScopeId, conflict.objectId)
    const payload = parseJson(conflict.payloadJson)
    if (!entity || !payload) continue
    const identity = `${conflict.conflictId}:${entity.lifecycleRevision}:${entity.documentSequence}`
    const conflictId = await createDeterministicServerObjectId(
      input.workspaceId, 'requeued-conflict', identity,
    )
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'requeued-conflict-command', identity,
    )
    const encrypted = await encryptSyncV2Payload(input.workspaceKey, payload, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
      keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
    })
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
      type: 'create-conflict', commandId, conflictId, objectId: entity.objectId,
      kind: entity.kind as SyncV2ObjectKind, conflictType: conflict.type,
      expectedRevision: entity.lifecycleRevision === '0' ? null : entity.lifecycleRevision,
      expectedDocumentSequence: entity.documentId ? entity.documentSequence : null,
      keyVersion: input.keyVersion, ...encrypted,
    } })
    await upsertSyncV2Conflict({
      ...conflict, conflictId, createdAt: Date.now(), payloadJson: JSON.stringify(payload),
    })
    await retireBlockedSyncV2ConflictCommand(input.syncScopeId, conflict.conflictId)
    await resolveLocalSyncV2Conflict(input.syncScopeId, conflict.conflictId)
  }
}

async function materializeCrdtEntity(
  input: RuntimeInput,
  entity: SyncV2Entity,
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
    await markSyncV2EntityDocumentMaterialized(
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
    await markSyncV2EntityDocumentMaterialized(
      input.syncScopeId, entity.objectId, entity.documentSequence,
    )
  }
}

async function resolveLegacyNoteCrdtSnapshotConflicts(input: RuntimeInput): Promise<void> {
  for (const conflict of await listSyncV2Conflicts(input.syncScopeId)) {
    if (conflict.kind !== 'note' || conflict.type !== 'initial-import'
      || conflict.createdSequence === '0') continue
    const payload = parseJson(conflict.payloadJson) as {
      base?: unknown
      remote?: unknown
    } | null
    if (payload?.base !== '' || payload.remote !== '') continue
    const entity = await getSyncV2Entity(input.syncScopeId, conflict.objectId)
    const lifecycle = parseJson(entity?.basePayloadJson ?? '') as { type?: unknown } | null
    if (!entity || lifecycle?.type !== 'crdt-object') continue
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'resolve-legacy-note-crdt-conflict', conflict.conflictId,
    )
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
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
  const candidates = await listUnreferencedSyncV2AssetEntities(
    input.syncScopeId, Date.now() - ORPHAN_ASSET_GRACE_MS,
  )
  for (const entity of candidates) {
    if (await hasUnresolvedSyncV2ConflictForObject(input.syncScopeId, entity.objectId)) continue
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
    const envelope = await encryptSyncV2Payload(input.workspaceKey, payload ?? {
      schemaVersion: 2, type: 'asset', resourceId: entity.objectId,
    }, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: 'asset',
      keyVersion: input.keyVersion, purpose: 'object', identity: entity.objectId,
    })
    const conflictEnvelope = await encryptSyncV2Payload(input.workspaceKey, {
      schemaVersion: 2, type: 'delete-orphan-asset', resourceId: entity.objectId,
      path: payload?.localPath ?? entity.name,
    }, {
      workspaceId: input.workspaceId, objectId: entity.objectId, kind: 'asset',
      keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
    })
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
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
  for (const entity of await listRetiredSyncV2Entities(input.syncScopeId)) {
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
      encryptSyncV2Payload(input.workspaceKey, payload, {
        workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: input.keyVersion, purpose: 'object', identity: entity.objectId,
      }),
      encryptSyncV2Payload(input.workspaceKey, {
        schemaVersion: 2, type: 'retire-superseded-identity', objectId: entity.objectId,
      }, {
        workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
      }),
    ])
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
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
    const active = new Set(await listRecentActiveSyncV2TransferBlobIds(scopeId, cutoff))
    await cleanupStaleNoteGenServerBlobDownloads(active, cutoff)
  } catch (error) {
    console.warn('Failed to clean stale NoteGen Server Blob downloads:', error)
  }
}

async function recoverSyncV2Mutations(input: RuntimeInput): Promise<void> {
  const recoverable = await listRecoverableSyncV2Mutations(input.syncScopeId)
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
    await completeSyncV2Mutation(input.syncScopeId, mutation.mutationId)
  }
}

type DeferredBootstrapObject = {
  object: SyncV2BootstrapObject
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
    && !await hasUnresolvedSyncV2ConflictForObject(input.syncScopeId, object.objectId)) {
    const logicalKey = logicalKeyForPayload(payload, object.objectId)
    const name = logicalKey.split('/').filter(Boolean).at(-1) ?? logicalKey
    const commandId = await createDeterministicServerObjectId(
      input.workspaceId, 'blind-index-backfill', `${object.objectId}:${object.currentRevision}`,
    )
    const conflictId = await createDeterministicServerObjectId(
      input.workspaceId, 'blind-index-conflict', `${object.objectId}:${object.currentRevision}`,
    )
    const [envelope, conflictEnvelope] = await Promise.all([
      encryptSyncV2Payload(input.workspaceKey, payload, {
        workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
        keyVersion: input.keyVersion, purpose: 'object', identity: object.objectId,
      }),
      encryptSyncV2Payload(input.workspaceKey, {
        schemaVersion: 2, type: 'same-name', objectId: object.objectId,
        parentObjectId: resolvedParentObjectId, path: logicalKey, name,
      }, {
        workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
        keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
      }),
    ])
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
      type: 'upsert-object', commandId, objectId: object.objectId, kind: object.kind,
      parentObjectId: resolvedParentObjectId, nameCiphertext: envelope.ciphertext,
      nameBlindIndex: await createSyncV2NameBlindIndex({
        key: getSyncV2StableBlindIndexKey(input.workspaceKeys, input.workspaceKey),
        workspaceId: input.workspaceId, parentObjectId: resolvedParentObjectId, name,
      }),
      nameBlindIndexKeyVersion: getSyncV2StableBlindIndexKeyVersion(input.workspaceKeys),
      nameConflictId: conflictId, nameConflictCiphertext: conflictEnvelope.ciphertext,
      nameConflictCiphertextHash: conflictEnvelope.ciphertextHash,
      baseRevision: object.currentRevision, blobRefs: object.blobRefs,
      keyVersion: input.keyVersion, ...envelope,
    } })
  }
  if (object.document) {
    await upsertLocalSyncV2Document({
      scopeId: input.syncScopeId, documentId: object.document.documentId,
      objectId: object.objectId, kind: object.kind,
      latestDocumentSequence: object.document.latestDocumentSequence,
      checkpointDocumentSequence: object.document.checkpointDocumentSequence,
      checkpointId: object.document.checkpointId,
      checkpointKeyVersion: object.document.checkpointKeyVersion,
      checkpointCiphertext: object.document.checkpointCiphertext,
      checkpointCiphertextHash: object.document.checkpointCiphertextHash,
    })
    const entity = await getSyncV2Entity(input.syncScopeId, object.objectId)
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
  const current = await getSyncV2Entity(input.syncScopeId, object.objectId)
  const entity: SyncV2Entity = current ?? {
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
  const encrypted = await encryptSyncV2Payload(input.workspaceKey, conflictPayload, {
    workspaceId: input.workspaceId, objectId: object.objectId, kind: object.kind,
    keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
    type: 'create-conflict', commandId, conflictId, objectId: object.objectId, kind: object.kind,
    conflictType: 'reference-target-deleted', expectedRevision: object.currentRevision,
    expectedDocumentSequence: entity.documentSequence, keyVersion: input.keyVersion, ...encrypted,
  } })
  await upsertSyncV2Conflict({
    scopeId: input.syncScopeId, conflictId, objectId: object.objectId, kind: object.kind,
    type: 'reference-target-deleted', status: 'unresolved', createdSequence: '0',
    payloadJson: JSON.stringify(conflictPayload), createdAt: Date.now(), resolvedAt: null,
  })
  await upsertSyncV2Entity({
    ...entity,
    lifecycleRevision: object.currentRevision,
    basePayloadJson: JSON.stringify(payload),
  })
}

async function ensureBootstrap(input: RuntimeInput): Promise<void> {
  if (await isSyncV2BootstrapComplete(input.syncScopeId)) return
  const savedProgress = await getSyncV2BootstrapProgress(input.syncScopeId)
  let afterObjectId = savedProgress?.afterObjectId ?? undefined
  let bootstrapId = savedProgress?.bootstrapId
  let snapshotSequence = savedProgress?.snapshotSequence ?? '0'
  let deferredObjects: DeferredBootstrapObject[] = []
  const bootstrapKinds = new Set<string>([
    'note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark',
    'conversation', 'memory', 'setting',
  ])
  let restartedExpiredSnapshot = false
  do {
    let page: Awaited<ReturnType<typeof bootstrapSyncV2>>
    try {
      page = await bootstrapSyncV2({
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
        await clearSyncV2BootstrapProgress(input.syncScopeId)
        bootstrapId = undefined
        afterObjectId = undefined
        snapshotSequence = '0'
        deferredObjects = []
        continue
      }
      throw error
    }
    if ((bootstrapId !== undefined && bootstrapId !== page.bootstrapId)
      || (snapshotSequence !== '0' && snapshotSequence !== page.snapshotSequence)) {
      await clearSyncV2BootstrapProgress(input.syncScopeId)
      throw new Error('服务端 Bootstrap 快照在分页期间发生变化')
    }
    bootstrapId = page.bootstrapId
    snapshotSequence = page.snapshotSequence
    for (const object of page.objects) {
      try {
        bootstrapKinds.add(object.kind)
        const migratedEntity = await getSyncV2Entity(input.syncScopeId, object.objectId)
        const resolvedParentObjectId = object.parentObjectId ?? migratedEntity?.parentObjectId ?? null
        const key = input.workspaceKeys.get(object.keyVersion)
        if (!key) throw new SyncV2KeyMissingError(object.keyVersion)
        const payload = await decryptSyncV2Payload(key, object.ciphertext, {
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
      await saveSyncV2BootstrapProgress(input.syncScopeId, {
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
  await markSyncV2BootstrapComplete(input.syncScopeId, snapshotSequence)
}

async function importPendingOperations(input: RuntimeInput): Promise<void> {
  const entries = await listNoteGenServerOutbox(input.syncScopeId, 10_000)
  const consumedObjectIds = new Set<string>()
  const folderDeletes = entries.filter(entry => entry.action === 'delete' && entry.kind === 'folder')
    .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length)
  for (const rootEntry of folderDeletes) {
    if (consumedObjectIds.has(rootEntry.objectId)) continue
    const subtree = (await listSyncV2SubtreeEntities(input.syncScopeId, rootEntry.objectId))
      .filter(entity => entity.lifecycleRevision !== '0')
    if (subtree.length === 0) {
      await deleteNoteGenServerOutboxEntry(rootEntry.id, rootEntry.operationId)
      continue
    }
    const conflictId = crypto.randomUUID()
    const conflictEnvelope = await encryptSyncV2Payload(input.workspaceKey, {
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
      const envelope = await encryptSyncV2Payload(input.workspaceKey, payload, {
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
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
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
    if (await hasUnresolvedSyncV2ConflictForObject(input.syncScopeId, entry.objectId)) {
      // The conflict envelope already durably preserves this local intent.
      // Keeping the staging entry makes every reconciliation cycle rediscover
      // and retry the same mutation while the user has done nothing.
      await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
      await completeSyncV2Mutation(input.syncScopeId, entry.operationId)
      continue
    }
    const entity = await getSyncV2Entity(input.syncScopeId, entry.objectId)
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
      await setSyncV2Transfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
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
              await setSyncV2Transfer({
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
      await setSyncV2Transfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
        direction: 'upload', state: stageAssetBinding ? 'pending' : 'complete' })
    } catch (error) {
      const message = errorMessage(error)
      await setSyncV2Transfer({ scopeId: input.syncScopeId, transferId, objectId: entry.objectId,
        direction: 'upload', state: 'failed', error: message })
      const failedTransfer = await getSyncV2Transfer(input.syncScopeId, transferId)
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
      await replaceSyncV2ResourceRefs({
        scopeId: input.syncScopeId,
        ownerObjectId: entry.objectId,
        resources: prepared.resources.map(resource => ({
          resourceObjectId: resource.resourceId,
          localPath: resource.localPath,
        })),
      })
    } else if (entry.action === 'upsert' && !stageAssetBinding && !hasAssets) {
      await replaceSyncV2ResourceRefs({
        scopeId: input.syncScopeId, ownerObjectId: entry.objectId, resources: [],
      })
    }
    const envelope = await encryptSyncV2Payload(input.workspaceKey, prepared.payload, {
      workspaceId: input.workspaceId, objectId: entry.objectId, kind: entry.kind,
      keyVersion: input.keyVersion, purpose: 'object', identity: entry.objectId,
    })
    let command: SyncV2Command
    if (entry.action === 'delete') {
      if (!entity || entity.lifecycleRevision === '0') {
        await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
        continue
      }
      const conflictId = crypto.randomUUID()
      const basePayload = parseJson(entity.basePayloadJson) as { relativePath?: string, content?: string } | null
      const conflictEnvelope = await encryptSyncV2Payload(input.workspaceKey, {
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
      const nameConflictEnvelope = await encryptSyncV2Payload(input.workspaceKey, {
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
          nameBlindIndex: await createSyncV2NameBlindIndex({
            key: getSyncV2StableBlindIndexKey(input.workspaceKeys, input.workspaceKey),
            workspaceId: input.workspaceId, parentObjectId, name,
          }),
          nameBlindIndexKeyVersion: getSyncV2StableBlindIndexKeyVersion(input.workspaceKeys),
          nameConflictId,
          nameConflictCiphertext: nameConflictEnvelope.ciphertext,
          nameConflictCiphertextHash: nameConflictEnvelope.ciphertextHash,
        } : {}),
        blobRefs: prepared.blobRefs,
        resourceObjectIds: prepared.resources.map(resource => resource.resourceId),
        keyVersion: input.keyVersion, ...envelope,
      }
    }
    await enqueueSyncV2Command({ scopeId: input.syncScopeId, command })
  }
}

async function flushV2Outbox(input: RuntimeInput): Promise<{ count: number, conflicts: string[] }> {
  let count = 0
  const conflicts: string[] = []
  while (true) {
    const entries = await listSyncV2Outbox(input.syncScopeId, 100)
    if (entries.length === 0) break
    const commands = entries.map(entry => JSON.parse(entry.commandJson) as SyncV2Command)
    const results = await pushSyncV2Commands({
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
          if (await replaceReusedSyncV2Command(input.syncScopeId, outbox)) continue
        }
        if (command.type === 'delete-object' && result.code === 'revision_conflict'
          && result.revision
          && await rebaseSyncV2DeleteCommand(input.syncScopeId, outbox, result.revision)) {
          continue
        }
        if (result.code === 'revision_conflict') {
          // A stale immutable command cannot become valid by retrying it. Drop
          // it without surfacing a permanent block; staged local intent is
          // reconstructed after the authoritative remote revision is pulled.
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          continue
        }
        if (command.type === 'create-conflict' && result.code === 'conflict_id_reused') {
          // The server already owns this deterministic conflict ID. Encrypted
          // payloads use random nonces, so rebuilding the same semantic
          // conflict can legitimately produce different ciphertext. Retire
          // this command and immediately requeue the local conflict under a
          // fresh derived identity instead of permanently blocking sync.
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          await requeueOrphanedLocalConflicts(input)
          continue
        }
        if (command.type === 'commit-checkpoint' && result.code === 'checkpoint_not_current') {
          // Checkpoints are immutable encrypted commands. Retrying one with an
          // obsolete coverage sequence can never succeed; a later session
          // checkpoint will be generated from the converged Yjs state.
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          continue
        }
        if (command.type === 'resolve-conflict' && result.code === 'required_command_not_applied') {
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          continue
        }
        await failSyncV2Command(input.syncScopeId, result.commandId,
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
          && await rebaseSyncV2DeleteCommand(input.syncScopeId, outbox, result.revision)) {
          // Lifecycle revisions are optimistic concurrency guards. Rebase the
          // deletion automatically, while retaining expectedDocumentSequence
          // so a real delete-vs-edit race still produces a resolvable conflict.
          continue
        }
        if (command.type === 'upsert-object' && result.code === 'revision_conflict') {
          // The corresponding remote object event is durable and will create
          // the typed local conflict without discarding the staged local value.
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        if (command.type === 'resolve-conflict'
          && (result.code === 'conflict_changed' || result.code === 'same_name_still_conflicts')) {
          await completeSyncV2Command(input.syncScopeId, result.commandId)
          conflicts.push(command.objectId ?? result.commandId)
          continue
        }
        await failSyncV2Command(input.syncScopeId, result.commandId,
          result.code ?? 'command_conflict', true)
        conflicts.push(command.objectId ?? result.commandId)
        continue
      }
      if (command.type === 'create-conflict' && result.status === 'applied'
        && result.sequence && result.conflictId) {
        const localConflict = await getSyncV2Conflict(input.syncScopeId, result.conflictId)
        if (localConflict && localConflict.createdSequence === '0') {
          await upsertSyncV2Conflict({
            ...localConflict,
            createdSequence: result.sequence,
          })
        }
      }
      await completeSyncV2Command(input.syncScopeId, result.commandId)
      await completeSyncV2Mutation(input.syncScopeId, result.commandId)
      if (Array.isArray(command.mutationIds)) {
        for (const mutationId of command.mutationIds) {
          if (typeof mutationId === 'string') await completeSyncV2Mutation(input.syncScopeId, mutationId)
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
    const remaining = await listSyncV2Outbox(input.syncScopeId, 100)
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
  const entity = await getSyncV2Entity(input.syncScopeId, resource.resourceId)
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
  const envelope = await encryptSyncV2Payload(input.workspaceKey, payload, {
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
  await enqueueSyncV2Command({
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
  await setSyncV2Transfer({
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
  const health = await getSyncV2HealthSnapshot(input.syncScopeId)
  let after = health.receivedCursor
  let received = 0
  while (true) {
    const page = await pullSyncV2Events({
      baseUrl: input.baseUrl, accessToken: input.session.accessToken,
      workspaceId: input.workspaceId, after,
      ...(input.syncEpoch === undefined ? {} : { expectedSyncEpoch: input.syncEpoch }),
    })
    for (const event of page.events) await storeSyncV2Event(input.syncScopeId, event)
    after = page.nextCursor
    received += page.events.length
    await updateSyncV2Cursor(input.syncScopeId, after, page.latestSequence)
    if (!page.hasMore) break
  }
  return received
}

async function applyInbox(input: RuntimeInput): Promise<{ count: number, conflicts: string[] }> {
  let count = 0
  const conflicts: string[] = []
  let rows = await listUnappliedSyncV2Events(input.syncScopeId)
  while (rows.length > 0) {
    const deferred = [] as typeof rows
    const deferredReferences = new Map<string, Array<{ kind: 'tag' | 'mark', id: string }>>()
    let appliedThisPass = 0
    for (const row of rows) {
      const event = JSON.parse(row.eventJson) as SyncV2Event
      try {
        await beginSyncV2EventApply(input.syncScopeId, event.eventId, row.eventJson)
        const conflict = await applyEvent(input, event)
        if (conflict) conflicts.push(conflict)
        await completeSyncV2Event(input.syncScopeId, event.eventId)
        count += 1
        appliedThisPass += 1
      } catch (error) {
        const missingReferences = getMissingStructuredReferences(error)
        if (missingReferences) {
          await deferSyncV2Event(input.syncScopeId, event.eventId, errorMessage(error))
          deferred.push(row)
          deferredReferences.set(event.eventId, missingReferences)
          continue
        }
        await failSyncV2Event(input.syncScopeId, event.eventId, errorMessage(error))
        if (error instanceof SyncV2KeyMissingError) throw error
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

async function applyEvent(input: RuntimeInput, event: SyncV2Event): Promise<string | null> {
  if (event.type === 'document.updated' || event.type === 'document.checkpointed') {
    if (!event.objectId || !event.documentId || !event.ciphertext || !event.keyVersion) return null
    const kind = String(event.metadata.kind ?? 'note')
    const identity = event.type === 'document.updated'
      ? String(event.metadata.updateId) : String(event.metadata.checkpointId)
    const key = input.workspaceKeys.get(event.keyVersion)
    if (!key) throw new SyncV2KeyMissingError(event.keyVersion)
    const update = await decryptSyncV2Payload<Uint8Array>(key, event.ciphertext, {
      workspaceId: input.workspaceId, objectId: event.objectId, kind,
      keyVersion: event.keyVersion, purpose: event.type === 'document.updated' ? 'update' : 'checkpoint', identity,
    }, true)
    emitter.emit('note-gen-server-document-update', {
      documentId: event.documentId, update, checkpoint: event.type === 'document.checkpointed',
    })
    const entity = await getSyncV2Entity(input.syncScopeId, event.objectId)
    const updatedEntity = entity ? { ...entity, documentId: event.documentId,
      documentSequence: event.documentSequence ?? entity.documentSequence } : null
    if (updatedEntity) await upsertSyncV2Entity(updatedEntity)
    const localDocument = await getLocalSyncV2Document(input.syncScopeId, event.documentId)
    await upsertLocalSyncV2Document({
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
      const localConflict = await getSyncV2Conflict(input.syncScopeId, conflictId)
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
      await resolveLocalSyncV2Conflict(input.syncScopeId, conflictId)
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
  const kind = String(event.metadata.kind) as SyncV2ObjectKind
  const key = input.workspaceKeys.get(event.keyVersion)
  if (!key) throw new SyncV2KeyMissingError(event.keyVersion)
  const payload = await decryptSyncV2Payload<unknown>(key, event.ciphertext, {
    workspaceId: input.workspaceId, objectId: event.objectId, kind,
    keyVersion: event.keyVersion, purpose: 'object', identity: event.objectId,
  })
  return await materializeObject(input, event, kind, payload)
}

async function applyConflictCreated(input: RuntimeInput, event: SyncV2Event): Promise<string | null> {
  if (!event.objectId || !event.ciphertext || !event.keyVersion) throw new Error('冲突事件缺少密文')
  const conflictId = String(event.metadata.conflictId ?? '')
  const kind = String(event.metadata.kind ?? 'note')
  const conflictType = String(event.metadata.conflictType ?? 'content')
  const existing = conflictId ? await getSyncV2Conflict(input.syncScopeId, conflictId) : null
  if (existing && existing.objectId === event.objectId
    && existing.kind === kind && existing.type === conflictType) {
    // Older servers could emit the same durable conflict again when a client
    // retried with a fresh command ID. Advance the inbox cursor without
    // decrypting, reopening, or notifying about the same conflict hundreds of times.
    return event.objectId
  }
  const key = input.workspaceKeys.get(event.keyVersion)
  if (!key || !conflictId) throw new Error('冲突事件无法解密')
  const payload = await decryptSyncV2Payload(key, event.ciphertext, {
    workspaceId: input.workspaceId, objectId: event.objectId, kind,
    keyVersion: event.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await upsertSyncV2Conflict({
    scopeId: input.syncScopeId, conflictId, objectId: event.objectId, kind,
    type: conflictType, status: 'unresolved',
    createdSequence: event.sequence, payloadJson: JSON.stringify(payload),
    createdAt: Date.parse(event.createdAt) || Date.now(), resolvedAt: null,
  })
  emitter.emit('note-gen-server-conflict-created', { conflictId, objectId: event.objectId, kind })
  return event.objectId
}

async function materializeObject(
  input: RuntimeInput, event: SyncV2Event, kind: SyncV2ObjectKind, payload: unknown,
): Promise<string | null> {
  const revision = String(event.metadata.revision ?? '0')
  const current = await getSyncV2Entity(input.syncScopeId, event.objectId!)
  const logicalKey = kind === 'asset' && payload && typeof payload === 'object'
    ? assetEntityLocalKey(
        typeof (payload as Record<string, unknown>).localPath === 'string'
          ? (payload as Record<string, unknown>).localPath as string
          : event.objectId!,
        (payload as Record<string, unknown>).scope === 'workspace' ? 'workspace' : 'appData',
        event.objectId!,
      )
    : logicalKeyForPayload(payload, current?.localKey ?? event.objectId!)
  const localKeyOwner = await getSyncV2EntityByLocalKey(input.syncScopeId, logicalKey)
  const identityCollision = localKeyOwner?.objectId !== event.objectId ? localKeyOwner : null
  const entity: SyncV2Entity = current ?? {
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
    await setSyncV2Transfer({
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
    await setSyncV2Transfer({
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
          await setSyncV2Transfer({
            scopeId: input.syncScopeId, transferId: `blob-download:${progress.blobId}`,
            objectId: event.objectId!, blobId: progress.blobId, direction: 'download',
            state: progress.completedBytes >= progress.totalBytes ? 'complete' : 'running',
            completedBytes: progress.completedBytes, totalBytes: progress.totalBytes,
          })
        },
      })
      await setSyncV2Transfer({
        scopeId: input.syncScopeId, transferId, objectId: event.objectId!,
        direction: 'download', state: 'complete',
      })
      if (kind === 'asset') {
        await completeSyncV2TransfersForObject(input.syncScopeId, event.objectId!)
      }
      if (assetBinding) {
        await setSyncV2Transfer({
          scopeId: input.syncScopeId,
          transferId: `asset-binding:${event.objectId}:${assetBinding.operationId}`,
          objectId: event.objectId!, direction: 'download', state: 'complete',
        })
      }
    } catch (error) {
      await setSyncV2Transfer({
        scopeId: input.syncScopeId, transferId, objectId: event.objectId!,
        direction: 'download', state: 'failed', error: errorMessage(error),
      })
      if (assetBinding) {
        await setSyncV2Transfer({
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
        await upsertSyncV2Entity({
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
    await replaceSyncV2ResourceRefs({
      scopeId: input.syncScopeId, ownerObjectId: event.objectId!, resources: [],
    })
    await upsertSyncV2Entity({
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
      await upsertSyncV2Entity({
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
      await upsertSyncV2Entity({ ...entity, lifecycleRevision: revision, basePayloadJson: JSON.stringify(payload) })
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
      await upsertSyncV2Entity({ ...entity, kind,
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
        getSyncV2EntityByLocalKey(input.syncScopeId, path),
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
        await upsertSyncV2Entity({ ...conflictEntity, lifecycleRevision: revision,
          basePayloadJson: JSON.stringify(payload) })
        await settlePendingOperationForConflict(input.syncScopeId, event.objectId!, revision)
        return conflictId
      }
      if (resolvingConflict && folderIdentityCollision) {
        await retireSyncV2EntityIdentity(input.syncScopeId, targetEntity.objectId, entity.objectId)
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
          module.moveSyncV2EntityLocalKey(input.syncScopeId, previousPath, path)
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
          await upsertSyncV2Entity({ ...entity, lifecycleRevision: revision, basePayloadJson: JSON.stringify(payload) })
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
      await upsertSyncV2Entity({ ...entity, kind,
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
      await retireSyncV2EntityIdentity(input.syncScopeId, identityCollision.objectId, entity.objectId)
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
    await replaceSyncV2ResourceRefs({
      scopeId: input.syncScopeId, ownerObjectId: event.objectId!, resources: resourceRefs,
    })
  }
  if (identityCollision) {
    await retireSyncV2EntityIdentity(input.syncScopeId, identityCollision.objectId, entity.objectId)
  }
  await upsertSyncV2Entity({ ...entity, kind, localKey: logicalKey,
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
  kind: SyncV2ObjectKind,
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
  input: RuntimeInput, entity: SyncV2Entity, expectedRevision: string, payload: unknown,
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
  const encrypted = await encryptSyncV2Payload(input.workspaceKey, payload, {
    workspaceId: input.workspaceId, objectId: entity.objectId, kind: entity.kind,
    keyVersion: input.keyVersion, purpose: 'conflict', identity: conflictId,
  })
  await enqueueSyncV2Command({ scopeId: input.syncScopeId, command: {
    type: 'create-conflict', commandId, conflictId, objectId: entity.objectId, kind: entity.kind,
    conflictType, expectedRevision,
    expectedDocumentSequence: entity.documentSequence, keyVersion: input.keyVersion, ...encrypted,
  } })
  await upsertSyncV2Conflict({
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
): Promise<SyncV2Entity> {
  const owned = await getSyncV2AssetEntityForOwnerPath(scopeId, ownerObjectId, localPath)
  if (owned) return owned
  const existing = await getSyncV2AssetEntityByPath(scopeId, localPath, scope, contentHash)
  if (existing) return existing
  const objectId = crypto.randomUUID()
  const entity: SyncV2Entity = {
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
  await upsertSyncV2Entity(entity)
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
