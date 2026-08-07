import { dirname } from '@tauri-apps/api/path'
import { exists, mkdir, readDir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs'

import {
  blockNoteGenServerOutboxEntry,
  completeNoteGenServerInboxEntry,
  completeNoteGenServerOutboxEntry,
  deleteNoteGenServerOutboxEntry,
  deleteNoteGenServerSyncObject,
  enqueueNoteGenServerInbox,
  failNoteGenServerInboxEntry,
  failNoteGenServerOutboxEntry,
  getNoteGenServerCursor,
  getNoteGenServerSyncQueueStats,
  getNoteGenServerSyncObject,
  hasPendingNoteGenServerOperation,
  listPendingNoteGenServerInbox,
  listNoteGenServerOutbox,
  listNoteGenServerSyncObjects,
  pruneAppliedNoteGenServerInbox,
  rebaseConflictedNoteGenServerOutboxEntry,
  setNoteGenServerCursor,
  settleConflictedNoteGenServerOutboxEntry,
  upsertNoteGenServerSyncObject,
} from '@/db/note-gen-server-sync'
import emitter from '@/lib/emitter'
import {
  ensureSafeWorkspaceRelativePath,
  getFilePathOptions,
  getWorkspacePath,
} from '@/lib/workspace'
import {
  acknowledgeServerCursor,
  createDeterministicNoteObjectId,
  createDeterministicServerObjectId,
  createEncryptedWorkspaceOperation,
  createServerSyncSession,
  decryptWorkspacePayload,
  listServerWorkspaceObjects,
  NoteGenServerRequestError,
  pullServerChanges,
  pushServerOperationBatch,
  type ServerSession,
} from './note-gen-server'
import {
  collectMarkdownNoteAssetReferences,
  hashMarkdownPayload,
  queueCurrentNoteGenServerMarkdownWorkspace,
  suppressNoteGenServerFolderRecreation,
  suppressNoteGenServerFileEvent,
} from './note-gen-server-outbox'
import {
  prepareNoteGenServerPayloadAssets,
  restoreNoteGenServerPayloadAssets,
  type NoteGenServerAssetReference,
} from './note-gen-server-assets'

interface MarkdownNotePayload {
  schemaVersion: 1
  type: 'markdown-note'
  relativePath: string
  content: string
  modifiedAt: string | null
  assets?: NoteGenServerAssetReference[]
}

interface FolderPayload {
  schemaVersion: 1
  type: 'folder'
  relativePath: string
}

export interface NoteGenServerSyncCycleResult {
  pushed: number
  pulled: number
  conflicts: string[]
  cursor: string
  pendingOutbox: number
  blockedOutbox: number
  storedInbox: number
  failedInbox: number
}

const reconciledWorkspaces = new Set<string>()
const lastAppDataReconciliationAt = new Map<string, number>()
const APP_DATA_RECONCILIATION_INTERVAL_MS = 60_000
const MAX_OBJECT_CIPHERTEXT_BYTES = 2 * 1024 * 1024
const MAX_PUSH_REQUEST_BYTES = 15 * 1024 * 1024

export function resetNoteGenServerRuntimeReconciliation(syncScopeId?: string): void {
  if (syncScopeId) {
    reconciledWorkspaces.delete(syncScopeId)
    lastAppDataReconciliationAt.delete(syncScopeId)
    return
  }
  reconciledWorkspaces.clear()
  lastAppDataReconciliationAt.clear()
}

export async function runNoteGenServerSyncCycle(input: {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncScopeId: string
  workspaceKey: CryptoKey
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  keyVersion: number
}): Promise<NoteGenServerSyncCycleResult> {
  const initialPull = await pullNoteGenServerWorkspaceChanges(input)
  const now = Date.now()
  const requiresFullReconciliation = !reconciledWorkspaces.has(input.syncScopeId)
    || now - (lastAppDataReconciliationAt.get(input.syncScopeId) ?? 0) >= APP_DATA_RECONCILIATION_INTERVAL_MS
  if (requiresFullReconciliation) {
    await queueCurrentNoteGenServerMarkdownWorkspace()
  }
  if (requiresFullReconciliation) {
    await import('./note-gen-server-domains').then(module => module.queueCurrentNoteGenServerAppData())
    lastAppDataReconciliationAt.set(input.syncScopeId, now)
  } else {
    await import('./note-gen-server-domains').then(module => (
      module.queueNoteGenServerDomainChange('settings')
    ))
  }
  const pushedResult = await flushNoteGenServerOutbox(input)
  const confirmationPull = pushedResult.applied > 0
    ? await pullNoteGenServerWorkspaceChanges(input)
    : { pulled: 0, conflicts: [], cursor: initialPull.cursor }
  if (!reconciledWorkspaces.has(input.syncScopeId)) reconciledWorkspaces.add(input.syncScopeId)
  await pruneAppliedNoteGenServerInbox(input.syncScopeId, Date.now() - 7 * 24 * 60 * 60_000)
  const queueStats = await getNoteGenServerSyncQueueStats(input.syncScopeId)
  return {
    pushed: pushedResult.applied,
    pulled: initialPull.pulled + confirmationPull.pulled,
    conflicts: [
      ...initialPull.conflicts,
      ...pushedResult.conflicts,
      ...confirmationPull.conflicts,
    ],
    cursor: confirmationPull.cursor,
    ...queueStats,
  }
}

export async function flushNoteGenServerOutbox(input: {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncScopeId: string
  workspaceKey: CryptoKey
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  keyVersion: number
}): Promise<{ applied: number, conflicts: string[] }> {
  let applied = 0
  const conflicts: string[] = []

  while (true) {
    const pendingEntries = await listNoteGenServerOutbox(input.syncScopeId, 100)
    const syncableEntries: typeof pendingEntries = []
    for (const entry of pendingEntries) {
      if (isConflictPath(entry.relativePath)) {
        await deleteNoteGenServerOutboxEntry(entry.id, entry.operationId)
        continue
      }
      syncableEntries.push(entry)
    }
    if (syncableEntries.length === 0) {
      if (pendingEntries.length === 0) return { applied, conflicts }
      continue
    }

    const preparedEntries: typeof syncableEntries = []
    const pendingOperations: Array<Awaited<ReturnType<typeof createEncryptedWorkspaceOperation>>> = []
    for (const entry of syncableEntries) {
      try {
        const localPayload = entry.payloadJson ? JSON.parse(entry.payloadJson) : {}
        const prepared = entry.action === 'delete'
          ? { payload: localPayload, blobRefs: [] }
          : await prepareNoteGenServerPayloadAssets({
              payload: localPayload,
              baseUrl: input.baseUrl,
              accessToken: input.session.accessToken,
              workspaceId: input.workspaceId,
              workspaceKey: input.workspaceKey,
            })
        pendingOperations.push(await createEncryptedWorkspaceOperation({
          operationId: entry.operationId,
          workspaceKey: input.workspaceKey,
          keyVersion: input.keyVersion,
          objectId: entry.objectId,
          kind: entry.kind as Parameters<typeof createEncryptedWorkspaceOperation>[0]['kind'],
          baseRevision: entry.baseRevision,
          payload: prepared.payload,
          blobRefs: prepared.blobRefs,
          delete: entry.action === 'delete',
        }))
        preparedEntries.push(entry)
      } catch (error) {
        if (!isPermanentPayloadPreparationError(error)) throw error
        await blockNoteGenServerOutboxEntry(
          entry.id,
          entry.operationId,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (preparedEntries.length === 0) continue
    const entries: typeof preparedEntries = []
    const operations: typeof pendingOperations = []
    let requestBytes = new TextEncoder().encode('{"operations":[]}').byteLength
    for (let index = 0; index < preparedEntries.length; index += 1) {
      const entry = preparedEntries[index]
      const operation = pendingOperations[index]
      if (base64UrlDecodedByteLength(operation.ciphertext) > MAX_OBJECT_CIPHERTEXT_BYTES) {
        await blockNoteGenServerOutboxEntry(entry.id, entry.operationId, 'object_too_large')
        continue
      }
      const operationBytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength + 1
      if (entries.length > 0 && requestBytes + operationBytes > MAX_PUSH_REQUEST_BYTES) break
      entries.push(entry)
      operations.push(operation)
      requestBytes += operationBytes
    }
    if (entries.length === 0) continue
    let results: Awaited<ReturnType<typeof pushServerOperationBatch>>
    let requestBlocked = false
    while (true) {
      try {
        results = await pushServerOperationBatch({
          baseUrl: input.baseUrl,
          accessToken: input.session.accessToken,
          workspaceId: input.workspaceId,
          operations,
        })
        break
      } catch (error) {
        if (!(error instanceof NoteGenServerRequestError) || error.status !== 413) throw error
        if (entries.length === 1) {
          await blockNoteGenServerOutboxEntry(entries[0].id, entries[0].operationId, error.code ?? 'request_too_large')
          results = []
          requestBlocked = true
          break
        }
        const nextSize = Math.max(1, Math.floor(entries.length / 2))
        entries.splice(nextSize)
        operations.splice(nextSize)
      }
    }
    if (requestBlocked) continue
    let batchFailure: string | null = null

    for (const entry of entries) {
      const result = results.find(item => item.operationId === entry.operationId)
      if (result?.status === 'applied' && result.revision) {
        await completeNoteGenServerOutboxEntry({
          entryId: entry.id,
          operationId: entry.operationId,
          workspaceId: entry.workspaceId,
          objectId: entry.objectId,
          kind: entry.kind,
          action: entry.action,
          relativePath: entry.relativePath,
          revision: result.revision,
          contentHash: entry.contentHash,
        })
        applied += 1
        continue
      }
      if (result?.status === 'conflict' && result.current) {
        const current = result.current
        await persistRemoteObject({
          syncScopeId: input.syncScopeId,
          workspaceId: input.workspaceId,
          objectId: current.objectId,
          revision: current.currentRevision,
          sequence: null,
          kind: current.kind,
          ciphertext: current.ciphertext,
          ciphertextHash: current.ciphertextHash,
          keyVersion: current.keyVersion,
          blobRefs: current.blobRefs,
          deleted: current.deletedAt !== null,
        })
        if (current.kind !== 'note' && current.kind !== 'conversation' && current.deletedAt === null) {
          await completeNoteGenServerInboxEntry(input.syncScopeId, current.objectId, current.currentRevision)
          await rebaseConflictedNoteGenServerOutboxEntry({
            entryId: entry.id,
            operationId: entry.operationId,
            remoteRevision: current.currentRevision,
          })
          continue
        }
        const conflictPath = await applyPersistedRemoteChange({
          baseUrl: input.baseUrl,
          accessToken: input.session.accessToken,
          syncScopeId: input.syncScopeId,
          workspaceId: input.workspaceId,
          workspaceKeys: input.workspaceKeys,
          objectId: current.objectId,
          revision: current.currentRevision,
          kind: current.kind,
          keyVersion: current.keyVersion,
          ciphertext: current.ciphertext,
          blobRefs: current.blobRefs,
          deleted: current.deletedAt !== null,
        })
        if (conflictPath) conflicts.push(conflictPath)
        if (current.kind === 'conversation') {
          await import('./note-gen-server-domains').then(module => (
            module.queueNoteGenServerDomainChange('conversations')
          ))
        }
        await settleConflictedNoteGenServerOutboxEntry({
          entryId: entry.id,
          operationId: entry.operationId,
          remoteRevision: current.currentRevision,
        })
        continue
      }
      const reason = result?.code ?? result?.status ?? 'missing_push_result'
      if (result?.status === 'rejected' && result.retryable === false) {
        await blockNoteGenServerOutboxEntry(entry.id, entry.operationId, reason)
      } else {
        const operationStillCurrent = await failNoteGenServerOutboxEntry(entry.id, entry.operationId, reason)
        if (operationStillCurrent) batchFailure ??= reason
      }
    }

    if (batchFailure) {
      throw new Error(`待同步本地数据无法提交：${batchFailure}`)
    }
  }
}

function isConflictPath(relativePath: string): boolean {
  return /\.conflict-[^/]+\.(?:md|markdown)$/i.test(relativePath)
}

function base64UrlDecodedByteLength(value: string): number {
  return Math.floor(value.length * 3 / 4)
}

function isPermanentPayloadPreparationError(error: unknown): boolean {
  if (error instanceof NoteGenServerRequestError) {
    return !error.retryable && error.status >= 400 && error.status < 500
      && error.status !== 408 && error.status !== 409 && error.status !== 429
  }
  return error instanceof Error && (
    error.message.startsWith('待同步资源不存在：')
    || error.message.startsWith('待同步资源在入队后发生变化：')
    || error.message.startsWith('同步资源路径不安全：')
    || error.message.startsWith('同步资源超过客户端 256 MiB 限制：')
  )
}

export async function pullNoteGenServerWorkspaceChanges(input: {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncScopeId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
}): Promise<{ pulled: number, conflicts: string[], cursor: string }> {
  await retryStoredNoteGenServerInbox(input)
  let cursor = await getNoteGenServerCursor(input.syncScopeId)
  const syncSession = await createServerSyncSession({
    baseUrl: input.baseUrl,
    accessToken: input.session.accessToken,
    workspaceId: input.workspaceId,
    cursor,
  })
  const conflicts: string[] = []
  if (syncSession.bootstrapRequired) {
    const restored = await restoreNoteGenServerWorkspace({
      ...input,
      conflicts,
    })
    cursor = restored.cursor
  }

  let pulled = 0
  while (true) {
    const page = await pullServerChanges({
      baseUrl: input.baseUrl,
      accessToken: input.session.accessToken,
      workspaceId: input.workspaceId,
      after: cursor,
    })
    const orderedChanges = [...page.changes].sort((left, right) => (
      snapshotKindPriority(left.kind) - snapshotKindPriority(right.kind)
    ))
    for (const change of orderedChanges) {
      await persistRemoteObject({
        syncScopeId: input.syncScopeId,
        workspaceId: input.workspaceId,
        objectId: change.objectId,
        revision: change.revision,
        sequence: change.sequence,
        kind: change.kind,
        ciphertext: change.ciphertext,
        ciphertextHash: change.ciphertextHash,
        keyVersion: change.keyVersion,
        blobRefs: change.blobRefs,
        deleted: change.deleted,
      })
      if (await hasPendingNoteGenServerOperation(input.syncScopeId, change.objectId)) {
        // Keep the remote revision in the inbox and continue with later
        // changes. A local pending operation must not block the whole cursor.
        continue
      }
      try {
        const conflictPath = await applyPersistedRemoteChange({
          baseUrl: input.baseUrl,
          accessToken: input.session.accessToken,
          syncScopeId: input.syncScopeId,
          workspaceId: input.workspaceId,
          workspaceKeys: input.workspaceKeys,
          objectId: change.objectId,
          revision: change.revision,
          kind: change.kind,
          keyVersion: change.keyVersion,
          ciphertext: change.ciphertext,
          blobRefs: change.blobRefs,
          deleted: change.deleted,
        })
        if (conflictPath) conflicts.push(conflictPath)
        pulled += 1
      } catch {
        // Keep the cursor moving so one damaged/temporarily undecryptable object
        // cannot block unrelated notes. The inbox entry is retained and retried
        // at the beginning of the next cycle.
      }
    }
    cursor = page.nextCursor
    await setNoteGenServerCursor(input.syncScopeId, cursor)
    await acknowledgeServerCursor({
      baseUrl: input.baseUrl,
      accessToken: input.session.accessToken,
      workspaceId: input.workspaceId,
      cursor,
    })
    if (!page.hasMore) return { pulled, conflicts, cursor }
  }
}

async function retryStoredNoteGenServerInbox(input: {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncScopeId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
}): Promise<void> {
  const pendingEntries = await listPendingNoteGenServerInbox(input.syncScopeId)
  for (const entry of pendingEntries) {
    if (await hasPendingNoteGenServerOperation(input.syncScopeId, entry.objectId)) continue
    try {
      await applyPersistedRemoteChange({
        baseUrl: input.baseUrl,
        accessToken: input.session.accessToken,
        syncScopeId: input.syncScopeId,
        workspaceId: input.workspaceId,
        workspaceKeys: input.workspaceKeys,
        objectId: entry.objectId,
        revision: entry.revision,
        kind: entry.kind,
        keyVersion: entry.keyVersion,
        ciphertext: entry.ciphertext,
        blobRefs: JSON.parse(entry.blobRefsJson) as string[],
        deleted: entry.deleted === 1,
      })
    } catch {
      // Keep retrying on a later foreground/background cycle.
    }
  }
}

async function restoreNoteGenServerWorkspace(input: {
  baseUrl: string
  session: ServerSession
  workspaceId: string
  syncScopeId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  conflicts: string[]
}): Promise<{ cursor: string }> {
  const snapshot = await listServerWorkspaceObjects({
    baseUrl: input.baseUrl,
    accessToken: input.session.accessToken,
    workspaceId: input.workspaceId,
  })
  // 标签必须先于引用它们的记录落库；服务端快照按 objectId 分页，不保证依赖顺序。
  const orderedSnapshotObjects = [...snapshot.objects].sort((left, right) => (
    snapshotKindPriority(left.kind) - snapshotKindPriority(right.kind)
  ))
  for (const object of orderedSnapshotObjects) {
    await persistRemoteObject({
      syncScopeId: input.syncScopeId,
      workspaceId: input.workspaceId,
      objectId: object.objectId,
      revision: object.currentRevision,
      sequence: snapshot.snapshotSequence,
      kind: object.kind,
      ciphertext: object.ciphertext,
      ciphertextHash: object.ciphertextHash,
      keyVersion: object.keyVersion,
      blobRefs: object.blobRefs,
      deleted: object.deletedAt !== null,
    })
    if (await hasPendingNoteGenServerOperation(input.syncScopeId, object.objectId)) {
      // Keep the remote snapshot in the inbox; the local outbox will resolve
      // this object later, while unrelated snapshot objects can be restored.
      continue
    }
    try {
      const conflictPath = await applyPersistedRemoteChange({
        baseUrl: input.baseUrl,
        accessToken: input.session.accessToken,
        syncScopeId: input.syncScopeId,
        workspaceId: input.workspaceId,
        workspaceKeys: input.workspaceKeys,
        objectId: object.objectId,
        revision: object.currentRevision,
        kind: object.kind,
        keyVersion: object.keyVersion,
        ciphertext: object.ciphertext,
        blobRefs: object.blobRefs,
        deleted: object.deletedAt !== null,
      })
      if (conflictPath) input.conflicts.push(conflictPath)
    } catch {
      // Keep the bootstrap cursor moving. The persisted inbox entry is retried
      // on the next cycle, so one damaged/temporarily undecryptable object
      // cannot prevent unrelated server data from being restored.
    }
  }
  const snapshotObjectIds = new Set(snapshot.objects.map(object => object.objectId))
  const trackedObjects = await listNoteGenServerSyncObjects(input.syncScopeId)
  for (const tracked of trackedObjects) {
    if (snapshotObjectIds.has(tracked.objectId)) continue
    if (await hasPendingNoteGenServerOperation(input.syncScopeId, tracked.objectId)) {
      throw new Error('完整恢复遇到远端已清理、但本地仍有待上传修改的数据')
    }
    if (tracked.kind === 'note') {
      const conflictPath = await removeMarkdownMissingFromSnapshot({
        ...tracked,
        workspaceId: input.workspaceId,
        syncScopeId: input.syncScopeId,
      })
      if (conflictPath) input.conflicts.push(conflictPath)
    } else if (tracked.kind === 'folder') {
      await removeFolderMissingFromSnapshot(tracked.relativePath)
      await deleteNoteGenServerSyncObject(input.syncScopeId, tracked.objectId)
    } else {
      await import('./note-gen-server-domains').then(module => (
        module.applyNoteGenServerMissingTrackedObject({
          kind: tracked.kind,
          logicalKey: tracked.relativePath,
        })
      ))
      await deleteNoteGenServerSyncObject(input.syncScopeId, tracked.objectId)
    }
  }
  await setNoteGenServerCursor(input.syncScopeId, snapshot.snapshotSequence)
  await acknowledgeServerCursor({
    baseUrl: input.baseUrl,
    accessToken: input.session.accessToken,
    workspaceId: input.workspaceId,
    cursor: snapshot.snapshotSequence,
  })
  return { cursor: snapshot.snapshotSequence }
}

function snapshotKindPriority(kind: string): number {
  if (kind === 'folder' || kind === 'tag') return 0
  if (kind === 'mark') return 1
  return 2
}

async function removeMarkdownMissingFromSnapshot(input: {
  syncScopeId: string
  workspaceId: string
  objectId: string
  relativePath: string
  contentHash: string | null
}): Promise<string | null> {
  const relativePath = await ensureSafeWorkspaceRelativePath(input.relativePath)
  const expectedObjectId = await createDeterministicNoteObjectId(input.workspaceId, relativePath)
  if (expectedObjectId !== input.objectId) throw new Error('本地 Markdown 同步索引路径与 ID 不匹配')
  const pathOptions = await getFilePathOptions(relativePath)
  const workspace = await getWorkspacePath()
  const localExists = workspace.isCustom
    ? await exists(pathOptions.path)
    : await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
  const localContent = localExists
    ? workspace.isCustom
      ? await readTextFile(pathOptions.path)
      : await readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })
    : null
  const localHash = localContent === null
    ? null
    : await hashMarkdownPayload(
        localContent,
        await collectMarkdownNoteAssetReferences(relativePath, localContent),
      )
  let conflictPath: string | null = null
  if (localContent !== null && localHash !== input.contentHash) {
    conflictPath = createConflictPath(relativePath)
    await writeWorkspaceTextFile(conflictPath, localContent)
    await reconcileLocalTreeEntry(conflictPath, true, false)
  }
  suppressNoteGenServerFileEvent(relativePath, null)
  if (localExists) {
    if (workspace.isCustom) await remove(pathOptions.path)
    else await remove(pathOptions.path, { baseDir: pathOptions.baseDir })
  }
  await reconcileLocalTreeEntry(relativePath, false, false)
  await import('@/stores/article').then(module => (
    module.default.getState().cleanTabsByDeletedFile(relativePath)
  ))
  await deleteNoteGenServerSyncObject(input.syncScopeId, input.objectId)
  return conflictPath
}

async function removeFolderMissingFromSnapshot(relativePath: string): Promise<boolean> {
  const safePath = await ensureSafeWorkspaceRelativePath(relativePath)
  suppressNoteGenServerFolderRecreation(safePath)
  const pathOptions = await getFilePathOptions(safePath)
  const present = pathOptions.baseDir
    ? await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
    : await exists(pathOptions.path)
  if (!present) {
    await reconcileLocalTreeEntry(relativePath, false, true)
    return true
  }
  const entries = pathOptions.baseDir
    ? await readDir(pathOptions.path, { baseDir: pathOptions.baseDir })
    : await readDir(pathOptions.path)
  if (entries.length > 0) return false
  if (pathOptions.baseDir) await remove(pathOptions.path, { baseDir: pathOptions.baseDir })
  else await remove(pathOptions.path)
  await reconcileLocalTreeEntry(relativePath, false, true)
  return true
}

async function persistRemoteObject(input: {
  syncScopeId: string
  workspaceId: string
  objectId: string
  revision: string
  sequence: string | null
  kind: string
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefs: string[]
  deleted: boolean
}): Promise<void> {
  await enqueueNoteGenServerInbox({ ...input, workspaceId: input.syncScopeId })
}

async function applyPersistedMarkdownChange(input: {
  baseUrl: string
  accessToken: string
  syncScopeId: string
  workspaceId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  objectId: string
  revision: string
  keyVersion: number
  ciphertext: string
  blobRefs: string[]
  deleted: boolean
}): Promise<string | null> {
  try {
    const conflictPath = await applyMarkdownChange(input)
    await completeNoteGenServerInboxEntry(input.syncScopeId, input.objectId, input.revision)
    return conflictPath
  } catch (error) {
    await failNoteGenServerInboxEntry(
      input.syncScopeId,
      input.objectId,
      input.revision,
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

async function applyPersistedRemoteChange(input: {
  baseUrl: string
  accessToken: string
  syncScopeId: string
  workspaceId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  objectId: string
  revision: string
  kind: string
  keyVersion: number
  ciphertext: string
  blobRefs: string[]
  deleted: boolean
}): Promise<string | null> {
  if (input.kind === 'note') return await applyPersistedMarkdownChange(input)
  if (input.kind === 'folder') return await applyPersistedFolderChange(input)
  try {
    const workspaceKey = input.workspaceKeys.get(input.keyVersion)
    if (!workspaceKey) throw new Error(`缺少 Workspace Key v${input.keyVersion}，无法解密远端对象`)
    const payload = await decryptWorkspacePayload<unknown>(workspaceKey, input.ciphertext)
    await import('./note-gen-server-domains').then(module => module.validateNoteGenServerDomainObjectIdentity({
      workspaceId: input.workspaceId,
      objectId: input.objectId,
      kind: input.kind,
      payload,
      deleted: input.deleted,
    }))
    if (!input.deleted && (input.kind === 'mark' || input.kind === 'canvas' || input.kind === 'conversation')) {
      await restoreNoteGenServerPayloadAssets({
        payload,
        blobRefs: input.blobRefs,
        baseUrl: input.baseUrl,
        accessToken: input.accessToken,
        workspaceId: input.workspaceId,
        workspaceKey,
      })
    }
    await import('./note-gen-server-domains').then(module => module.applyNoteGenServerDomainChange({
      syncScopeId: input.syncScopeId,
      workspaceId: input.workspaceId,
      objectId: input.objectId,
      kind: input.kind,
      revision: input.revision,
      payload,
      deleted: input.deleted,
    }))
    await completeNoteGenServerInboxEntry(input.syncScopeId, input.objectId, input.revision)
    return null
  } catch (error) {
    await failNoteGenServerInboxEntry(
      input.syncScopeId,
      input.objectId,
      input.revision,
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

async function applyPersistedFolderChange(input: {
  syncScopeId: string
  workspaceId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  objectId: string
  revision: string
  keyVersion: number
  ciphertext: string
  deleted: boolean
}): Promise<null> {
  try {
    const workspaceKey = input.workspaceKeys.get(input.keyVersion)
    if (!workspaceKey) throw new Error(`缺少 Workspace Key v${input.keyVersion}，无法解密远端文件夹`)
    const payload = await decryptWorkspacePayload<FolderPayload>(workspaceKey, input.ciphertext)
    if (payload.schemaVersion !== 1 || payload.type !== 'folder') throw new Error('服务器返回了无效的文件夹对象')
    const relativePath = await ensureSafeWorkspaceRelativePath(payload.relativePath)
    const expectedObjectId = await createDeterministicServerObjectId(input.workspaceId, 'folder', relativePath)
    if (expectedObjectId !== input.objectId) throw new Error('服务器文件夹对象路径与 ID 不匹配')
    if (input.deleted) {
      await removeFolderMissingFromSnapshot(relativePath)
      await deleteNoteGenServerSyncObject(input.syncScopeId, input.objectId)
    } else {
      const pathOptions = await getFilePathOptions(relativePath)
      if (pathOptions.baseDir) await mkdir(pathOptions.path, { baseDir: pathOptions.baseDir, recursive: true })
      else await mkdir(pathOptions.path, { recursive: true })
      await upsertNoteGenServerSyncObject({
        workspaceId: input.syncScopeId,
        objectId: input.objectId,
        kind: 'folder',
        relativePath,
        revision: input.revision,
        contentHash: await hashFolderPath(relativePath),
      })
      await reconcileLocalTreeEntry(relativePath, true, true)
    }
    await completeNoteGenServerInboxEntry(input.syncScopeId, input.objectId, input.revision)
    return null
  } catch (error) {
    await failNoteGenServerInboxEntry(
      input.syncScopeId,
      input.objectId,
      input.revision,
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

async function hashFolderPath(relativePath: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relativePath)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function applyMarkdownChange(input: {
  baseUrl: string
  accessToken: string
  syncScopeId: string
  workspaceId: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  objectId: string
  revision: string
  keyVersion: number
  ciphertext: string
  blobRefs: string[]
  deleted: boolean
}): Promise<string | null> {
  const tracked = await getNoteGenServerSyncObject(input.syncScopeId, input.objectId)
  const workspaceKey = input.workspaceKeys.get(input.keyVersion)
  if (!workspaceKey) throw new Error(`缺少 Workspace Key v${input.keyVersion}，无法解密远端 Markdown`)
  const payload = await decryptWorkspacePayload<MarkdownNotePayload>(workspaceKey, input.ciphertext)
  if (payload.schemaVersion !== 1 || payload.type !== 'markdown-note') {
    throw new Error('服务器返回了不兼容的 Markdown 对象')
  }
  const relativePath = await ensureSafeWorkspaceRelativePath(payload.relativePath || tracked?.relativePath || '')
  const expectedObjectId = await createDeterministicNoteObjectId(input.workspaceId, relativePath)
  if (expectedObjectId !== input.objectId) throw new Error('服务器 Markdown 对象路径与 ID 不匹配')
  if (!input.deleted) {
    await restoreNoteGenServerPayloadAssets({
      payload,
      blobRefs: input.blobRefs,
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      workspaceId: input.workspaceId,
      workspaceKey,
    })
  }
  const remoteHash = input.deleted ? null : await hashMarkdownPayload(payload.content, payload.assets)

  const pathOptions = await getFilePathOptions(relativePath)
  const workspace = await getWorkspacePath()
  const localExists = workspace.isCustom
    ? await exists(pathOptions.path)
    : await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
  const localContent = localExists
    ? workspace.isCustom
      ? await readTextFile(pathOptions.path)
      : await readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })
    : null
  const localHash = localContent === null
    ? null
    : await hashMarkdownPayload(
        localContent,
        await collectMarkdownNoteAssetReferences(relativePath, localContent),
      )
  const locallyChanged = localContent !== null
    && localHash !== remoteHash
    && (tracked === null || tracked.contentHash !== localHash)

  let conflictPath: string | null = null
  if (locallyChanged && localContent !== null) {
    conflictPath = createConflictPath(relativePath)
    await writeWorkspaceTextFile(conflictPath, localContent)
    await reconcileLocalTreeEntry(conflictPath, true, false)
  }

  suppressNoteGenServerFileEvent(relativePath, remoteHash)
  if (input.deleted) {
    if (localExists) {
      if (workspace.isCustom) await remove(pathOptions.path)
      else await remove(pathOptions.path, { baseDir: pathOptions.baseDir })
    }
  } else {
    await writeWorkspaceTextFile(relativePath, payload.content)
    emitter.emit('sync-content-updated', { path: relativePath, content: payload.content })
  }
  await reconcileLocalTreeEntry(relativePath, !input.deleted, false)
  if (input.deleted) {
    await import('@/stores/article').then(module => (
      module.default.getState().cleanTabsByDeletedFile(relativePath)
    ))
  }

  if (input.deleted) {
    await deleteNoteGenServerSyncObject(input.syncScopeId, input.objectId)
  } else {
    await upsertNoteGenServerSyncObject({
      workspaceId: input.syncScopeId,
      objectId: input.objectId,
      kind: 'note',
      relativePath,
      revision: input.revision,
      contentHash: remoteHash,
    })
  }
  return conflictPath
}

async function writeWorkspaceTextFile(relativePath: string, content: string): Promise<void> {
  const pathOptions = await getFilePathOptions(relativePath)
  const parent = await dirname(pathOptions.path)
  if (pathOptions.baseDir === undefined) {
    await mkdir(parent, { recursive: true })
    await writeTextFile(pathOptions.path, content)
    return
  }
  await mkdir(parent, { recursive: true, baseDir: pathOptions.baseDir })
  await writeTextFile(pathOptions.path, content, { baseDir: pathOptions.baseDir })
}

async function reconcileLocalTreeEntry(
  relativePath: string,
  isPresent: boolean,
  isDirectory: boolean,
): Promise<void> {
  const articleStore = await import('@/stores/article')
  const state = articleStore.default.getState()
  if (isPresent) {
    const segments = relativePath.split('/').filter(Boolean)
    for (let index = 1; index < segments.length; index += 1) {
      state.reconcileLocalFolder(segments.slice(0, index).join('/'), true)
    }
  }
  if (isDirectory) state.reconcileLocalFolder(relativePath, isPresent)
  else state.reconcileLocalFile(relativePath, isPresent)
}

function createConflictPath(relativePath: string): string {
  const marker = new Date().toISOString().replaceAll(/[:.]/g, '-')
  return relativePath.replace(/(\.(?:md|markdown))$/i, `.conflict-${marker}$1`)
}
