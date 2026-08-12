'use client'

import { Store } from '@tauri-apps/plugin-store'

import { filterSyncData, shouldExcludeFromSync } from '@/config/sync-exclusions'
import emitter from '@/lib/emitter'
import {
  enqueueNoteGenServerOutbox,
  deleteNoteGenServerSyncObject,
  getNoteGenServerOutboxForObject,
  listNoteGenServerSyncObjects,
  upsertNoteGenServerSyncObject,
  type NoteGenServerSyncObject,
} from '@/db/note-gen-server-sync'
import type { Mark } from '@/db/marks'
import type { Tag } from '@/db/tags'
import type { CanvasProject } from '@/types/canvas'
import type { Memory } from '@/db/memories'
import {
  applySyncAtomicBatch, getOrCreateSyncEntity, getSyncEntity,
  hasUnresolvedSyncConflictForObject,
  markSyncMutationQueued, recordSyncMutation, type SyncEntity,
  type SyncAtomicStatement,
} from '@/db/note-gen-server-sync-index'
import { getMarkLocalAssetPaths } from './record-assets'
import type { ConversationSyncItem, NoteGenServerConversationSnapshot } from './conversation-sync'
import { setAutoDataSyncApplyingRemote } from './auto-data-sync-bridge'
import {
  collectNoteGenServerAssetReferences,
  stripNoteGenServerAssetTransportFields,
  type NoteGenServerAssetReference,
} from './note-gen-server-assets'
import {
  createDeterministicServerObjectId,
  getNoteGenServerSyncScopeId,
  loadServerProfile,
} from './note-gen-server'

export type NoteGenServerDataDomain = 'records' | 'settings' | 'conversations' | 'memories'
type NoteGenServerDataKind = 'tag' | 'mark' | 'canvas' | 'setting' | 'conversation' | 'memory'

export class NoteGenServerMissingReferenceError extends Error {
  readonly code = 'note_gen_server_missing_reference'

  constructor(readonly references: Array<{ kind: 'tag' | 'mark', id: string }>) {
    const reference = references[0]
    super(reference?.kind === 'tag'
      ? `记录引用的标签尚未同步：${reference.id}`
      : `同步对象引用的记录尚未同步：${reference?.id ?? ''}`)
    this.name = 'NoteGenServerMissingReferenceError'
  }
}

type SyncedTag = Omit<Tag, 'id' | 'total' | 'syncId'> & { syncId: string, legacyId?: number }
type SyncedMark = Omit<Mark, 'id' | 'tagId' | 'syncId'> & {
  syncId: string
  tagSyncId: string
  legacyId?: number
}
interface TagPayload { schemaVersion: 1 | 2, type: 'tag', value: Tag | SyncedTag }
interface MarkPayload {
  schemaVersion: 1 | 2
  type: 'mark'
  value: Mark | SyncedMark
  assets?: NoteGenServerAssetReference[]
}
interface CanvasPayload {
  schemaVersion: 1
  type: 'canvas'
  value: CanvasProject
  assets?: NoteGenServerAssetReference[]
}
interface SettingPayload { schemaVersion: 1, type: 'setting', key: string, value: unknown }
// 兼容已经由旧版客户端上传的整包配置对象。新版不再创建这种对象。
interface LegacySettingsPayload { schemaVersion: 1, type: 'settings', value: Record<string, unknown> }
interface ConversationPayload {
  schemaVersion: 1
  type: 'conversation'
  value: ConversationSyncItem
  assets?: NoteGenServerAssetReference[]
}
interface MemoryPayload {
  schemaVersion: 1
  type: 'memory'
  value: Omit<Memory, 'embedding' | 'embeddingModel' | 'embeddingDimensions' | 'indexingStatus'
    | 'accessCount' | 'lastAccessedAt' | 'lastRecallReason'>
}
interface DeletePayload {
  schemaVersion: 1
  type: 'delete'
  kind: NoteGenServerDataKind
  logicalKey: string
  deletedAt: number
}
type AppDataPayload = TagPayload | MarkPayload | CanvasPayload | SettingPayload | LegacySettingsPayload | ConversationPayload | MemoryPayload | DeletePayload

interface LocalObject {
  kind: NoteGenServerDataKind
  logicalKey: string
  payload: AppDataPayload
}

const DOMAIN_KINDS: Record<NoteGenServerDataDomain, NoteGenServerDataKind[]> = {
  records: ['tag', 'mark', 'canvas'],
  settings: ['setting'],
  conversations: ['conversation'],
  memories: ['memory'],
}

const SUPPORTED_DATA_KINDS = new Set<NoteGenServerDataKind>(Object.values(DOMAIN_KINDS).flat())
const domainQueue = new Map<NoteGenServerDataDomain, Promise<boolean>>()
let preferencesSession: import('./note-gen-server-collab').NoteGenServerTextSession | null = null
let bootstrapSettingsStore: Awaited<ReturnType<typeof Store.load>> | null = null
const structuredSubscriptions = new Map<string, Array<() => void>>()

export async function queueNoteGenServerDomainChange(domain: NoteGenServerDataDomain): Promise<boolean> {
  const previous = domainQueue.get(domain) ?? Promise.resolve(false)
  const current = previous.catch(() => false).then(() => queueNoteGenServerDomainChangeNow(domain))
  domainQueue.set(domain, current)
  try {
    return await current
  } finally {
    if (domainQueue.get(domain) === current) domainQueue.delete(domain)
  }
}

async function queueNoteGenServerDomainChangeNow(domain: NoteGenServerDataDomain): Promise<boolean> {
  const profile = await loadServerProfile()
  if (!profile?.enabled || !profile.workspaceId || !profile.localWorkspaceKey) return false
  const syncScopeId = await getNoteGenServerSyncScopeId(profile)
  const [localObjects, trackedObjects] = await Promise.all([
    collectLocalObjects(domain, syncScopeId),
    listNoteGenServerSyncObjects(syncScopeId),
  ])
  const trackedById = new Map(trackedObjects.map(object => [object.objectId, object]))
  const localIds = new Set<string>()
  let queued = false

  for (const object of localObjects) {
    const entity = await getOrCreateSyncEntity({
      scopeId: syncScopeId, kind: object.kind, localKey: object.logicalKey,
      stableWorkspaceId: profile.workspaceId,
    })
    const objectId = entity.objectId
    localIds.add(objectId)
    // A durable conflict already owns reconciliation for this object. Starting
    // CRDT collaboration or staging another local mutation here turns every
    // background scan into a new retry and can create an endless sync echo.
    if (await hasUnresolvedSyncConflictForObject(syncScopeId, objectId)) continue
    await ensureStructuredObjectCollaboration({
      workspaceId: profile.workspaceId, syncScopeId, objectId, object,
    })
    queued = await queueObject({
      syncScopeId,
      objectId,
      object,
      entity,
      tracked: trackedById.get(objectId) ?? null,
    }) || queued
  }

  for (const tracked of trackedObjects) {
    if (!DOMAIN_KINDS[domain].includes(tracked.kind as NoteGenServerDataKind) || localIds.has(tracked.objectId)) continue
    queued = await queueDeletedObject(syncScopeId, tracked) || queued
  }
  return queued
}

export async function ensureNoteGenServerStructuredObjectFromPayload(input: {
  workspaceId: string
  syncScopeId: string
  objectId: string
  kind: string
  payload: unknown
}): Promise<void> {
  if (!SUPPORTED_DATA_KINDS.has(input.kind as NoteGenServerDataKind)) return
  const parsed = parsePayload(input.payload, input.kind, false)
  await ensureStructuredObjectCollaboration({
    workspaceId: input.workspaceId, syncScopeId: input.syncScopeId, objectId: input.objectId,
    object: { kind: input.kind as NoteGenServerDataKind,
      logicalKey: logicalKeyForPayload(parsed as Exclude<AppDataPayload, DeletePayload>), payload: parsed },
  })
}

async function ensureStructuredObjectCollaboration(input: {
  workspaceId: string
  syncScopeId: string
  objectId: string
  object: LocalObject
}): Promise<void> {
  const subscriptionKey = `${input.workspaceId}:${input.objectId}`
  const entity = await getSyncEntity(input.syncScopeId, input.objectId)
  if (!entity || entity.lifecycleRevision === '0') return
  if (await hasUnresolvedSyncConflictForObject(input.syncScopeId, input.objectId)) return
  const collab = await import('./note-gen-server-collab')
  const initialFields = fieldsForCrdtPayload(input.object.payload)
  const session = input.object.payload.type === 'conversation'
    ? await collab.getNoteGenServerConversationSession({
        workspaceId: input.workspaceId,
        conversationSyncId: input.object.payload.value.syncId,
        initialMessages: input.object.payload.value.messages,
      })
    : await collab.getNoteGenServerStructuredSession({
        workspaceId: input.workspaceId, documentId: input.object.logicalKey, initialFields,
      })
  if (!session) return
  session.setFields(initialFields, {
    preserveUnknown: input.object.payload.type === 'settings',
  })
  if (input.object.payload.type === 'conversation') session.setMessages(input.object.payload.value.messages)
  if (input.object.payload.type === 'canvas') {
    session.setCanvasGraph(input.object.payload.value.document.nodes, input.object.payload.value.document.edges)
  }
  if (structuredSubscriptions.has(subscriptionKey)) return
  let latestFields = session.getFields()
  let latestMessages = session.getMessages()
  let latestCanvas = session.getCanvasGraph()
  let applyQueue = Promise.resolve()
  const apply = () => {
    const fields = structuredClone(latestFields)
    const messages = structuredClone(latestMessages)
    const canvas = structuredClone(latestCanvas)
    applyQueue = applyQueue.then(async () => {
      const payload = payloadFromCrdtFields(fields, messages, canvas)
      if (!payload) return
      await applyNoteGenServerDomainChange({
        syncScopeId: input.syncScopeId, workspaceId: input.workspaceId, objectId: input.objectId,
        kind: input.object.kind, revision: entity.lifecycleRevision, payload, deleted: false,
        stableIdentity: true,
      })
    }).catch(() => undefined)
  }
  const unsubscribers = [session.subscribeFields(fields => {
    latestFields = fields
    apply()
  })]
  if (input.object.payload.type === 'conversation') {
    unsubscribers.push(session.subscribeMessages(messages => {
      latestMessages = messages
      apply()
    }))
  }
  if (input.object.payload.type === 'canvas') {
    unsubscribers.push(session.subscribeCanvas(canvas => {
      latestCanvas = canvas
      apply()
    }))
  }
  structuredSubscriptions.set(subscriptionKey, unsubscribers)
}

function fieldsForCrdtPayload(payload: AppDataPayload): Record<string, unknown> {
  if (payload.type === 'delete') return {}
  if (payload.type === 'setting') return { $schemaVersion: payload.schemaVersion, $type: payload.type,
    key: payload.key, value: payload.value }
  if (payload.type === 'settings') return { $schemaVersion: payload.schemaVersion, $type: payload.type, ...payload.value }
  const value = { ...payload.value } as Record<string, unknown>
  if (payload.type === 'conversation') delete value.messages
  if (payload.type === 'canvas') {
    const document = payload.value.document
    value.document = { schemaVersion: document.schemaVersion, viewport: document.viewport, settings: document.settings }
  }
  return { $schemaVersion: payload.schemaVersion, $type: payload.type, ...value }
}

function payloadFromCrdtFields(
  fields: Record<string, unknown>, messages: unknown[], canvas: { nodes: unknown[], edges: unknown[] },
): AppDataPayload | null {
  const type = fields.$type
  const schemaVersion = fields.$schemaVersion
  if (typeof type !== 'string' || (schemaVersion !== 1 && schemaVersion !== 2)) return null
  const value = { ...fields }
  delete value.$type
  delete value.$schemaVersion
  if (type === 'setting') return { schemaVersion: 1, type, key: String(value.key ?? ''), value: value.value }
  if (type === 'settings') return { schemaVersion: 1, type, value }
  if (type === 'conversation') value.messages = messages
  if (type === 'canvas') {
    const document = value.document && typeof value.document === 'object'
      ? value.document as Record<string, unknown> : {}
    value.document = { ...document, nodes: canvas.nodes, edges: canvas.edges }
  }
  return { schemaVersion, type, value } as AppDataPayload
}

export async function materializeNoteGenServerCrdtEntity(input: {
  syncScopeId: string
  workspaceId: string
  entity: SyncEntity
  refreshView?: boolean
}): Promise<boolean> {
  const snapshot = await import('./note-gen-server-collab').then(module => (
    module.loadNoteGenServerStructuredSnapshot({
      workspaceId: input.workspaceId, entity: input.entity,
    })
  ))
  if (!snapshot) return false
  const payload = payloadFromCrdtFields(snapshot.fields, snapshot.messages, snapshot.canvas)
  // A newly created document can expose an earlier Yjs update before the
  // update carrying its type metadata arrives. Keep the entity pending so a
  // later document event (or the next reconciliation cycle) can retry it.
  if (!payload) return false
  if (input.entity.kind === 'mark' && input.entity.localKey === 'mark:settings'
    && payload.type === 'settings') {
    // Older clients inferred the legacy `settings` logical key as a mark
    // document. Retire that polluted server object instead of applying its
    // preference fields to the records table.
    await queueDeletedObject(input.syncScopeId, {
      workspaceId: input.syncScopeId,
      objectId: input.entity.objectId,
      kind: input.entity.kind,
      relativePath: input.entity.localKey,
      revision: input.entity.lifecycleRevision,
      contentHash: null,
    })
    return true
  }
  await applyNoteGenServerDomainChange({
    syncScopeId: input.syncScopeId,
    workspaceId: input.workspaceId,
    objectId: input.entity.objectId,
    kind: input.entity.kind,
    revision: input.entity.lifecycleRevision,
    payload,
    deleted: false,
    stableIdentity: true,
    refreshView: input.refreshView,
  })
  return true
}

export async function queueCurrentNoteGenServerAppData(): Promise<number> {
  let queued = 0
  for (const domain of ['records', 'settings', 'conversations', 'memories'] as const) {
    if (await queueNoteGenServerDomainChange(domain)) queued += 1
  }
  return queued
}

export async function applyNoteGenServerDomainChange(input: {
  syncScopeId: string
  workspaceId: string
  objectId: string
  kind: string
  revision: string
  payload: unknown
  deleted: boolean
  stableIdentity?: boolean
  refreshView?: boolean
}): Promise<void> {
  if (input.kind === 'setting' && isConnectionTestPayload(input.payload)) return
  if (!SUPPORTED_DATA_KINDS.has(input.kind as NoteGenServerDataKind)) return
  const { payload, logicalKey } = await resolveIncomingPayload(input)
  if (!input.stableIdentity) {
    const expectedObjectId = await createDeterministicServerObjectId(input.workspaceId, input.kind, logicalKey)
    if (expectedObjectId !== input.objectId) throw new Error('服务器应用数据对象的身份与内容不匹配')
  }
  setAutoDataSyncApplyingRemote(true)
  try {
    if (payload.type === 'delete') await applyDeletion(payload)
    else if (payload.type === 'tag') await applyTag(payload.value)
    else if (payload.type === 'mark') await applyMark(payload.value)
    else if (payload.type === 'canvas') await applyCanvas(payload.value)
    else if (payload.type === 'setting') await applySetting(
      payload.key, payload.value, input.refreshView !== false,
    )
    else if (payload.type === 'settings') await applyLegacySettings(
      payload.value, input.refreshView !== false,
    )
    else if (payload.type === 'conversation') await applyConversation(payload.value)
    else if (payload.type === 'memory') await import('@/db/memories').then(module => module.upsertMemoryFromSync(payload.value))
  } finally {
    setAutoDataSyncApplyingRemote(false)
  }

  if (input.deleted) {
    await deleteNoteGenServerSyncObject(input.syncScopeId, input.objectId)
  } else {
    await upsertNoteGenServerSyncObject({
      workspaceId: input.syncScopeId,
      objectId: input.objectId,
      kind: input.kind,
      relativePath: logicalKey,
      revision: input.revision,
      contentHash: await hashPayload(JSON.stringify(input.payload)),
    })
  }
}

/**
 * Applies lifecycle snapshots whose stable references can be expressed in one
 * SQL batch. CRDT sessions and file/store-backed domains keep their durable
 * journal path because they cannot participate in the SQLite transaction.
 */
export async function applyNoteGenServerDomainChangeAtomic(input: {
  syncScopeId: string
  eventId: string
  entity: SyncEntity
  revision: string
  payload: unknown
  deleted: boolean
  resourceRefs?: Array<{ resourceObjectId: string, localPath: string }>
}): Promise<boolean> {
  if (!['tag', 'mark', 'memory'].includes(input.entity.kind)) return false
  const resolved = await resolveIncomingPayload({
    kind: input.entity.kind, payload: input.payload, deleted: input.deleted,
  })
  let deletedMarkId: number | null = null
  const operations: SyncAtomicStatement[] = []
  if (resolved.payload.type === 'delete') {
    const stableId = resolved.payload.logicalKey.slice(resolved.payload.logicalKey.indexOf(':') + 1)
    if (resolved.payload.kind === 'tag') {
      operations.push({
        statement: `delete from tags where syncId = $1 and isLocked = false
          and not exists (select 1 from marks where marks.tagId = tags.id)`, values: [stableId],
      })
      operations.push({
        statement: 'delete from tag_sync_aliases where syncId = $1', values: [stableId],
      })
    } else if (resolved.payload.kind === 'mark') {
      deletedMarkId = await import('@/db/marks').then(module => (
        module.getMarkBySyncId(stableId).then(mark => mark?.id ?? null)
      ))
      operations.push({ statement: 'delete from marks where syncId = $1', values: [stableId] })
    } else if (resolved.payload.kind === 'memory') {
      operations.push({ statement: 'delete from memories where id = $1', values: [stableId] })
    }
    operations.push({
      statement: 'delete from note_gen_server_sync_objects where workspaceId = $1 and objectId = $2',
      values: [input.syncScopeId, input.entity.objectId],
    })
  } else if (resolved.payload.type === 'tag' && resolved.payload.schemaVersion === 2) {
    const tag = resolved.payload.value as SyncedTag
    operations.push({
      statement: `insert into tags(name,isLocked,isPin,sortOrder,syncId)
        select $1,$2,$3,$4,$5 where not exists (
          select 1 from tags where syncId=$5 or ($2=true and isLocked=true and name=$1)
        )`,
      values: [tag.name, tag.isLocked ?? false, tag.isPin ?? false, tag.sortOrder ?? 0, tag.syncId],
    }, {
      statement: `update tags set name=$1,isLocked=$2,isPin=$3,sortOrder=$4,
        syncId=coalesce(syncId,$5)
        where syncId=$5 or ($2=true and isLocked=true and name=$1)`,
      values: [tag.name, tag.isLocked ?? false, tag.isPin ?? false, tag.sortOrder ?? 0, tag.syncId],
    }, {
      statement: `insert into tag_sync_aliases(syncId,tagId)
        select $1,id from tags where syncId=$1 or ($2=true and isLocked=true and name=$3) limit 1
        on conflict(syncId) do update set tagId=excluded.tagId`,
      values: [tag.syncId, tag.isLocked ?? false, tag.name],
    })
  } else if (resolved.payload.type === 'mark' && resolved.payload.schemaVersion === 2) {
    const mark = resolved.payload.value as SyncedMark
    operations.push({
      statement: `insert into marks(tagId,type,content,url,desc,deleted,createdAt,sourceId,syncId)
        values(coalesce(
          (select id from tags where syncId=$1 limit 1),
          (select tagId from tag_sync_aliases where syncId=$1 limit 1)
        ),$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict do update set tagId=excluded.tagId,type=excluded.type,content=excluded.content,
          url=excluded.url,desc=excluded.desc,deleted=excluded.deleted,createdAt=excluded.createdAt,
          sourceId=excluded.sourceId,syncId=excluded.syncId`,
      values: [mark.tagSyncId, mark.type, mark.content ?? null, mark.url ?? '', mark.desc ?? null,
        mark.deleted ?? 0, mark.createdAt, mark.sourceId ?? null, mark.syncId],
    })
  } else if (resolved.payload.type === 'memory') {
    const memory = resolved.payload.value
    operations.push({
      statement: `insert into memories(id,content,embedding,category,replaced_id,access_count,
        last_accessed_at,created_at,updated_at,kind,scope_type,scope_id,apply_mode,status,
        origin,confidence,conflict_key,embedding_model,embedding_dimensions,indexing_status,
        sensitivity,last_recall_reason,archived_at)
        values($1,$2,'',$3,$4,0,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,null,null,'pending',$15,null,$16)
        on conflict(id) do update set content=excluded.content,category=excluded.category,
          replaced_id=excluded.replaced_id,updated_at=excluded.updated_at,kind=excluded.kind,
          scope_type=excluded.scope_type,scope_id=excluded.scope_id,apply_mode=excluded.apply_mode,
          status=excluded.status,origin=excluded.origin,confidence=excluded.confidence,
          conflict_key=excluded.conflict_key,sensitivity=excluded.sensitivity,
          archived_at=excluded.archived_at,embedding='',embedding_model=null,
          embedding_dimensions=null,indexing_status='pending'`,
      values: [memory.id, memory.content, memory.category, memory.replacedId ?? null,
        memory.createdAt, memory.updatedAt, memory.kind, memory.scopeType, memory.scopeId ?? null,
        memory.applyMode, memory.status, memory.origin, memory.confidence,
        memory.conflictKey ?? null, memory.sensitivity, memory.archivedAt ?? null],
    })
  } else {
    return false
  }

  const now = Date.now()
  const payloadJson = JSON.stringify(input.payload)
  const payloadHash = await hashPayload(payloadJson)
  // Stable identity can replace a provisional/bootstrap identity for the same
  // logical key. Retire that stale row inside this transaction before either
  // unique index is touched; the runtime has already turned a genuinely
  // pending local edit into a conflict before reaching this path.
  operations.push({
    statement: `update sync_entities set localKey='__sync_replaced__/' || objectId,
      deleted=1,updatedAt=$4 where scopeId=$1 and localKey=$2 and objectId!=$3`,
    values: [input.syncScopeId, resolved.logicalKey, input.entity.objectId, now],
  }, {
    statement: `delete from note_gen_server_sync_objects
      where workspaceId=$1 and relativePath=$2 and objectId!=$3`,
    values: [input.syncScopeId, resolved.logicalKey, input.entity.objectId],
  })
  if (!input.deleted) {
    operations.push({
      statement: `insert into note_gen_server_sync_objects
        (workspaceId,objectId,kind,relativePath,revision,contentHash,updatedAt)
        values($1,$2,$3,$4,$5,$6,$7)
        on conflict(workspaceId,objectId) do update set kind=excluded.kind,
          relativePath=excluded.relativePath,revision=excluded.revision,
          contentHash=excluded.contentHash,updatedAt=excluded.updatedAt`,
      values: [input.syncScopeId, input.entity.objectId, input.entity.kind, resolved.logicalKey,
        input.revision, payloadHash, now],
    })
  }
  operations.push({
    statement: 'delete from sync_resource_refs where scopeId=$1 and ownerObjectId=$2',
    values: [input.syncScopeId, input.entity.objectId],
  })
  if (!input.deleted) {
    for (const resource of input.resourceRefs ?? []) {
      operations.push({
        statement: `insert into sync_resource_refs
          (scopeId,ownerObjectId,resourceObjectId,localPath,updatedAt)
          values($1,$2,$3,$4,$5)`,
        values: [input.syncScopeId, input.entity.objectId, resource.resourceObjectId,
          resource.localPath, now],
      })
    }
  }
  operations.push({
    statement: `insert into sync_entities(scopeId,objectId,kind,localKey,parentObjectId,name,
      lifecycleRevision,documentId,documentSequence,materializedHash,basePayloadJson,deleted,updatedAt)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      on conflict(scopeId,objectId) do update set kind=excluded.kind,localKey=excluded.localKey,
        parentObjectId=excluded.parentObjectId,name=excluded.name,
        lifecycleRevision=excluded.lifecycleRevision,documentId=excluded.documentId,
        documentSequence=excluded.documentSequence,materializedHash=excluded.materializedHash,
        basePayloadJson=excluded.basePayloadJson,deleted=excluded.deleted,updatedAt=excluded.updatedAt`,
    values: [input.syncScopeId, input.entity.objectId, input.entity.kind, resolved.logicalKey,
      input.entity.parentObjectId, resolved.logicalKey.split('/').at(-1) ?? resolved.logicalKey,
      input.revision, input.entity.documentId, input.entity.documentSequence,
      payloadHash, payloadJson, input.deleted ? 1 : 0, now],
  })
  operations.push({
    statement: `update sync_inbox set status='applied',lastError=null,appliedAt=$3
      where scopeId=$1 and eventId=$2`,
    values: [input.syncScopeId, input.eventId, now],
  }, {
    statement: 'delete from sync_apply_journal where scopeId=$1 and eventId=$2',
    values: [input.syncScopeId, input.eventId],
  })
  await applySyncAtomicBatch(operations)
  if (deletedMarkId !== null) {
    await import('@/stores/article').then(module => (
      module.default.getState().cleanTabsByDeletedFile(`record://mark/${deletedMarkId}`)
    ))
    emitter.emit('sync-object-deleted', { kind: 'mark', localId: deletedMarkId })
  }
  return true
}

export async function refreshNoteGenServerAtomicDomainView(kind: string): Promise<void> {
  if (kind === 'tag') {
    await import('@/stores/tag').then(async module => {
      await module.default.getState().fetchTags()
      module.default.getState().getCurrentTag()
    })
  } else if (kind === 'mark') {
    await import('@/stores/mark').then(async module => {
      await Promise.all([module.default.getState().fetchMarks(), module.default.getState().fetchAllMarks()])
    })
  } else if (kind === 'memory') {
    await import('@/lib/memory/cache-version').then(module => module.invalidateMemoryCache())
    void import('@/db/memories').then(module => module.reindexPendingMemories())
  }
}

export async function refreshNoteGenServerBootstrapViews(kinds: ReadonlySet<string>): Promise<void> {
  for (const kind of ['tag', 'mark', 'memory']) {
    if (kinds.has(kind)) await refreshNoteGenServerAtomicDomainView(kind)
  }
  if (kinds.has('setting')) {
    if (bootstrapSettingsStore) {
      await bootstrapSettingsStore.save()
      bootstrapSettingsStore = null
    }
    await import('@/stores/setting').then(module => module.default.getState().initSettingData())
  }
}

export async function validateNoteGenServerDomainObjectIdentity(input: {
  workspaceId: string
  objectId: string
  kind: string
  payload: unknown
  deleted: boolean
}): Promise<void> {
  if (!SUPPORTED_DATA_KINDS.has(input.kind as NoteGenServerDataKind)) return
  if (input.kind === 'setting' && isConnectionTestPayload(input.payload)) return
  const { logicalKey } = await resolveIncomingPayload(input)
  const expectedObjectId = await createDeterministicServerObjectId(input.workspaceId, input.kind, logicalKey)
  if (expectedObjectId !== input.objectId) throw new Error('服务器应用数据对象的身份与内容不匹配')
}

async function resolveIncomingPayload(input: {
  kind: string
  payload: unknown
  deleted: boolean
}): Promise<{ payload: AppDataPayload, logicalKey: string }> {
  const hasDeletePayload = input.deleted && isDeletePayload(input.payload, input.kind)
  const parsedPayload = parsePayload(input.payload, input.kind, hasDeletePayload)
  const payload: AppDataPayload = input.deleted && !hasDeletePayload
    ? {
        schemaVersion: 1,
        type: 'delete',
        kind: input.kind as NoteGenServerDataKind,
        logicalKey: logicalKeyForPayload(parsedPayload as Exclude<AppDataPayload, DeletePayload>),
        deletedAt: Date.now(),
      }
    : parsedPayload
  const logicalKey = payload.type === 'delete'
    ? payload.logicalKey
    : logicalKeyForPayload(payload)
  return { payload, logicalKey }
}

export async function applyNoteGenServerMissingTrackedObject(input: {
  kind: string
  logicalKey: string
}): Promise<void> {
  if (!SUPPORTED_DATA_KINDS.has(input.kind as NoteGenServerDataKind)) return
  setAutoDataSyncApplyingRemote(true)
  try {
    await applyDeletion({
      schemaVersion: 1,
      type: 'delete',
      kind: input.kind as NoteGenServerDataKind,
      logicalKey: input.logicalKey,
      deletedAt: Date.now(),
    })
  } finally {
    setAutoDataSyncApplyingRemote(false)
  }
}

function isConnectionTestPayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).type === 'connection-test')
}

function isDeletePayload(value: unknown, kind: string): value is DeletePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return payload.schemaVersion === 1
    && payload.type === 'delete'
    && payload.kind === kind
    && typeof payload.logicalKey === 'string'
    && typeof payload.deletedAt === 'number'
}

async function collectLocalObjects(domain: NoteGenServerDataDomain, syncScopeId: string): Promise<LocalObject[]> {
  if (domain === 'records') {
    await import('@/db/tags').then(module => module.repairOrphanedMarkTags(syncScopeId))
    const [tags, allMarks, canvases] = await Promise.all([
      import('@/db/tags').then(module => module.getTags()),
      import('@/db/marks').then(module => module.getAllMarks()),
      import('@/db/canvases').then(module => module.getCanvasProjects()),
    ])
    // Tombstones are generated below from the tracked server objects. Keeping
    // soft-deleted rows in the upsert scan turns a local delete into an
    // ordinary upsert containing `deleted: 1`/`deletedAt`, so the server never
    // records a delete change and other devices cannot apply the deletion
    // semantics consistently.
    const marks = allMarks.filter(mark => mark.deleted === 0)
    const tagSyncIds = new Map(tags.map(tag => [tag.id, tag.syncId ?? null]))
    const markSyncIds = new Map(allMarks.map(mark => [mark.id, mark.syncId ?? null]))
    return [
      ...tags.map(tag => {
        const value = { ...tag }
        Reflect.deleteProperty(value, 'id')
        Reflect.deleteProperty(value, 'total')
        return {
          kind: 'tag' as const,
          logicalKey: `tag:${tag.syncId}`,
          payload: {
            schemaVersion: 2 as const,
            type: 'tag' as const,
            value: { ...value, syncId: tag.syncId as string },
          },
        }
      }),
      ...(await Promise.all(marks.map(async originalMark => {
        const { tagId, syncId } = originalMark
        const mark = omitKeys(originalMark, ['id', 'tagId', 'syncId'] as const)
        const tagSyncId = tagSyncIds.get(tagId)
        if (!tagSyncId) throw new Error(`记录 ${syncId} 引用了不存在的标签 ${tagId}`)
        const syncedFilePath = await cacheFileRecordForSync(originalMark)
        const syncedMark = {
          ...mark,
          ...(originalMark.type === 'file' ? { url: syncedFilePath ?? '' } : {}),
        }
        const assets = await collectNoteGenServerAssetReferences(getMarkLocalAssetPaths(syncedMark as Mark))
        return {
          kind: 'mark' as const,
          logicalKey: `mark:${syncId}`,
          payload: {
            schemaVersion: 2 as const,
            type: 'mark' as const,
            value: {
              ...syncedMark,
              syncId: syncId as string,
              tagSyncId,
            },
            ...(assets.length > 0 ? { assets } : {}),
          },
        }
      }))),
      ...(await Promise.all(canvases.map(async originalCanvas => {
        const canvas = { ...originalCanvas }
        Reflect.deleteProperty(canvas, 'thumbnailPath')
        Reflect.deleteProperty(canvas, 'history')
        const value: CanvasProject = {
          ...canvas,
          document: {
            ...canvas.document,
            nodes: canvas.document.nodes.map(node => {
              const data = { ...node.data }
              if (typeof data.recordId === 'number') {
                const recordSyncId = markSyncIds.get(data.recordId)
                if (recordSyncId) data.recordSyncId = recordSyncId
                delete data.recordId
              }
              return { ...node, data }
            }),
          },
        }
        const assetPaths = value.document.nodes.flatMap(node => {
          const path = typeof node.data.imagePath === 'string' ? node.data.imagePath : ''
          return /^(?:screenshot|image|recordings|link-assets)\//.test(path) ? [path] : []
        })
        const assets = await collectNoteGenServerAssetReferences(assetPaths)
        return {
          kind: 'canvas' as const,
          logicalKey: `canvas:${canvas.id}`,
          payload: {
            schemaVersion: 1 as const,
            type: 'canvas' as const,
            value,
            ...(assets.length > 0 ? { assets } : {}),
          },
        }
      }))),
    ]
  }
  if (domain === 'conversations') {
    const snapshot = await import('./conversation-sync').then(module => (
      module.createNoteGenServerConversationSnapshot()
    ))
    return await Promise.all(snapshot.items.map(async item => {
      const paths = await import('./conversation-sync').then(module => (
        module.getNoteGenServerConversationAssetPaths(item)
      ))
      const assets = await collectNoteGenServerAssetReferences(paths)
      return {
        kind: 'conversation' as const,
        logicalKey: `conversation:${item.syncId}`,
        payload: {
          schemaVersion: 1 as const,
          type: 'conversation' as const,
          value: item,
          ...(assets.length > 0 ? { assets } : {}),
        },
      }
    }))
  }
  if (domain === 'memories') {
    const memories = await import('@/db/memories').then(module => module.getAllMemories({ includeInactive: true }))
    return memories.map(memory => {
      const value = omitKeys(memory, [
        'embedding', 'embeddingModel', 'embeddingDimensions', 'indexingStatus',
        'accessCount', 'lastAccessedAt', 'lastRecallReason',
      ] as const)
      return { kind: 'memory' as const, logicalKey: `memory:${memory.id}`,
        payload: { schemaVersion: 1 as const, type: 'memory' as const, value } }
    })
  }
  const store = await Store.load('store.json')
  const entries = await store.entries()
  const settings = filterSyncData(Object.fromEntries(entries), {
    excludeSensitiveConfig: await store.get<boolean>('excludeSensitiveConfig') !== false,
  })
  return [{
    kind: 'setting',
    logicalKey: 'workspace-preferences',
    payload: { schemaVersion: 1, type: 'settings', value: settings },
  }]
}

export async function startNoteGenServerPreferencesCollaboration(workspaceId: string): Promise<void> {
  preferencesSession?.destroy()
  preferencesSession = null
  const store = await Store.load('store.json')
  const entries = await store.entries()
  const values = filterSyncData(Object.fromEntries(entries), {
    excludeSensitiveConfig: await store.get<boolean>('excludeSensitiveConfig') !== false,
  })
  const fields = { $schemaVersion: 1, $type: 'settings', ...values }
  const session = await import('./note-gen-server-collab').then(module => module.getNoteGenServerStructuredSession({
    workspaceId, documentId: 'workspace-preferences', initialFields: fields,
  }))
  if (!session) return
  preferencesSession = session
  session.setFields(fields, { preserveUnknown: true })
  session.subscribeFields(async next => {
    setAutoDataSyncApplyingRemote(true)
    try { await applyLegacySettings(next, true) } finally { setAutoDataSyncApplyingRemote(false) }
  })
}

export function stopNoteGenServerPreferencesCollaboration(): void {
  preferencesSession?.destroy()
  preferencesSession = null
}

async function queueObject(input: {
  syncScopeId: string
  objectId: string
  object: LocalObject
  entity: SyncEntity
  tracked: NoteGenServerSyncObject | null
}): Promise<boolean> {
  const payloadJson = JSON.stringify(input.object.payload)
  const contentHash = await hashPayload(payloadJson)
  const pending = await getNoteGenServerOutboxForObject(input.syncScopeId, input.objectId)
  if (pending?.action === 'upsert' && pending.contentHash === contentHash) return false
  const lifecyclePayload = parseJsonObject(input.entity.basePayloadJson)
  if (!pending && input.tracked?.contentHash === contentHash
    && lifecyclePayload && lifecyclePayload.type !== 'crdt-object') return false
  const operationId = crypto.randomUUID()
  await recordSyncMutation({
    scopeId: input.syncScopeId, mutationId: operationId, objectId: input.objectId,
    kind: input.object.kind, payload: input.object.payload,
  })
  await enqueueNoteGenServerOutbox({
    workspaceId: input.syncScopeId,
    operationId,
    objectId: input.objectId,
    kind: input.object.kind,
    relativePath: input.object.logicalKey,
    action: 'upsert',
    baseRevision: input.tracked?.revision ?? null,
    payloadJson,
    contentHash,
  })
  await markSyncMutationQueued(input.syncScopeId, operationId)
  return true
}

async function queueDeletedObject(syncScopeId: string, tracked: NoteGenServerSyncObject): Promise<boolean> {
  if (await hasUnresolvedSyncConflictForObject(syncScopeId, tracked.objectId)) return false
  const pending = await getNoteGenServerOutboxForObject(syncScopeId, tracked.objectId)
  if (pending?.action === 'delete') return false
  const payload: DeletePayload = {
    schemaVersion: 1,
    type: 'delete',
    kind: tracked.kind as NoteGenServerDataKind,
    logicalKey: tracked.relativePath,
    deletedAt: Date.now(),
  }
  const operationId = crypto.randomUUID()
  await recordSyncMutation({
    scopeId: syncScopeId, mutationId: operationId, objectId: tracked.objectId,
    kind: tracked.kind, payload,
  })
  await enqueueNoteGenServerOutbox({
    workspaceId: syncScopeId,
    operationId,
    objectId: tracked.objectId,
    kind: tracked.kind,
    relativePath: tracked.relativePath,
    action: 'delete',
    baseRevision: tracked.revision,
    payloadJson: JSON.stringify(payload),
    contentHash: null,
  })
  await markSyncMutationQueued(syncScopeId, operationId)
  return true
}

function parsePayload(value: unknown, kind: string, deleted: boolean): AppDataPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器返回了无效的应用数据对象')
  const payload = value as Record<string, unknown>
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw new Error('服务器返回了不兼容的应用数据对象')
  }
  if (payload.schemaVersion === 2 && payload.type !== 'tag' && payload.type !== 'mark') {
    throw new Error('服务器返回了不兼容的应用数据对象')
  }
  if (payload.schemaVersion === 2) {
    const value = payload.value
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as Record<string, unknown>).syncId !== 'string'
      || (payload.type === 'mark' && typeof (value as Record<string, unknown>).tagSyncId !== 'string')) {
      throw new Error('服务器返回了缺少稳定身份的应用数据对象')
    }
  }
  if (deleted && payload.type !== 'delete') throw new Error('服务器返回了无效的删除对象')
  if (payload.type === 'delete') {
    if (!deleted) throw new Error('服务器返回了状态不一致的删除对象')
    if (typeof payload.logicalKey !== 'string' || payload.kind !== kind || typeof payload.deletedAt !== 'number') {
      throw new Error('服务器返回了无效的删除对象')
    }
    return payload as unknown as DeletePayload
  }
  if (kind === 'setting') {
    if (payload.type === 'setting' && typeof payload.key === 'string' && 'value' in payload) {
      return payload as unknown as SettingPayload
    }
    if (payload.type === 'settings' && payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)) {
      return payload as unknown as LegacySettingsPayload
    }
    throw new Error('服务器对象类型不匹配：setting')
  }
  if (payload.type !== kind || !('value' in payload)) throw new Error(`服务器对象类型不匹配：${kind}`)
  return payload as unknown as AppDataPayload
}

async function applyTag(tag: Tag | SyncedTag): Promise<void> {
  const tagsDb = await import('@/db/tags')
  if (tag.syncId) {
    await tagsDb.upsertTagFromNoteGenServerSync({
      ...tag as SyncedTag,
      id: 'legacyId' in tag ? tag.legacyId : undefined,
    })
  } else {
    await tagsDb.insertTags([tag as Tag])
  }
  await import('@/stores/tag').then(async module => {
    await module.default.getState().fetchTags()
    module.default.getState().getCurrentTag()
  })
}

async function applyMark(mark: Mark | SyncedMark): Promise<void> {
  if (mark.syncId && 'tagSyncId' in mark && mark.tagSyncId) {
    const syncedMark = mark as SyncedMark
    const tag = await import('@/db/tags').then(module => module.getTagBySyncId(syncedMark.tagSyncId))
    if (!tag) {
      throw new NoteGenServerMissingReferenceError([{
        kind: 'tag',
        id: syncedMark.tagSyncId,
      }])
    }
    await import('@/db/marks').then(module => module.upsertMarkFromNoteGenServerSync(
      { ...syncedMark, id: syncedMark.legacyId },
      tag.id,
    ))
  } else {
    await import('@/db/marks').then(module => module.insertMarks([mark as Mark]))
  }
  await import('@/stores/mark').then(async module => {
    await Promise.all([module.default.getState().fetchMarks(), module.default.getState().fetchAllMarks()])
  })
}

async function applyCanvas(canvas: CanvasProject): Promise<void> {
  const recordSyncIds = new Set(canvas.document.nodes.flatMap(node => (
    typeof node.data.recordSyncId === 'string' ? [node.data.recordSyncId] : []
  )))
  const syncedMarks = new Map<string, Mark>()
  for (const syncId of recordSyncIds) {
    const mark = await import('@/db/marks').then(module => module.getMarkBySyncId(syncId))
    if (!mark) {
      throw new NoteGenServerMissingReferenceError([{ kind: 'mark', id: syncId }])
    }
    syncedMarks.set(syncId, mark)
  }
  await import('@/stores/canvas').then(module => module.acceptCanvasProjectFromSync(canvas.id))
  const nodes = await Promise.all(canvas.document.nodes.map(async node => {
    const data = { ...node.data }
    if (typeof data.recordSyncId === 'string') {
      const mark = syncedMarks.get(data.recordSyncId)
      if (mark) data.recordId = mark.id
      delete data.recordSyncId
    }
    return { ...node, data }
  }))
  await import('@/db/canvases').then(module => module.upsertCanvasProjectFromSync({
    ...canvas,
    document: { ...canvas.document, nodes },
  }))
  await import('@/stores/canvas').then(module => module.default.getState().loadProjects())
}

async function applySetting(key: string, value: unknown, refreshView: boolean): Promise<void> {
  const store = refreshView
    ? await Store.load('store.json')
    : bootstrapSettingsStore ??= await Store.load('store.json')
  const excludeSensitiveConfig = await store.get<boolean>('excludeSensitiveConfig') !== false
  if (!shouldExcludeFromSync(key, { excludeSensitiveConfig })) await store.set(key, value)
  if (refreshView) {
    await store.save()
    await import('@/stores/setting').then(module => module.default.getState().initSettingData())
  }
}

async function applyLegacySettings(settings: Record<string, unknown>, refreshView: boolean): Promise<void> {
  const store = refreshView
    ? await Store.load('store.json')
    : bootstrapSettingsStore ??= await Store.load('store.json')
  const excludeSensitiveConfig = await store.get<boolean>('excludeSensitiveConfig') !== false
  await store.delete('$type')
  await store.delete('$schemaVersion')
  for (const [key, item] of Object.entries(settings)) {
    if (key.startsWith('$')) continue
    if (!shouldExcludeFromSync(key, { excludeSensitiveConfig })) await store.set(key, item)
  }
  if (refreshView) {
    await store.save()
    await import('@/stores/setting').then(module => module.default.getState().initSettingData())
  }
}

async function applyConversation(item: ConversationSyncItem): Promise<void> {
  const snapshot: NoteGenServerConversationSnapshot = {
    schemaVersion: 1,
    type: 'conversation-snapshot',
    items: [item],
    tombstones: item.messageTombstones,
  }
  await import('./conversation-sync').then(module => module.applyNoteGenServerConversationSnapshot(snapshot))
}

async function applyDeletion(payload: DeletePayload): Promise<void> {
  const id = payload.logicalKey.slice(payload.logicalKey.indexOf(':') + 1)
  if (payload.kind === 'tag') {
    // 旧版使用本机自增 ID，跨设备删除会误删同号数据；迁移后只执行稳定 ID 墓碑。
    if (!Number.isFinite(Number(id))) {
      await import('@/db/tags').then(module => module.deleteTagBySyncId(id))
    }
    await import('@/stores/tag').then(async module => {
      await module.default.getState().fetchTags()
      module.default.getState().getCurrentTag()
    })
  } else if (payload.kind === 'mark') {
    const markId = Number.isFinite(Number(id))
      ? null
      : await import('@/db/marks').then(module => module.getMarkBySyncId(id).then(mark => mark?.id ?? null))
    if (markId !== null) {
      await import('@/stores/article').then(module => (
        module.default.getState().cleanTabsByDeletedFile(`record://mark/${markId}`)
      ))
      await import('@/db/marks').then(module => module.delMarkForever(markId))
      emitter.emit('sync-object-deleted', { kind: 'mark', localId: markId })
    }
    await import('@/stores/mark').then(async module => {
      await Promise.all([module.default.getState().fetchMarks(), module.default.getState().fetchAllMarks()])
    })
  } else if (payload.kind === 'canvas') {
    await import('@/stores/canvas').then(module => module.discardCanvasProjectFromSync(id))
    await import('@/stores/article').then(module => (
      module.default.getState().cleanTabsByDeletedFile(`canvas://project/${id}`)
    ))
    await import('@/db/canvases').then(module => module.permanentlyDeleteCanvasProject(id))
    emitter.emit('sync-object-deleted', { kind: 'canvas', localId: id })
    await import('@/stores/canvas').then(module => module.default.getState().loadProjects())
  }
  else if (payload.kind === 'setting') {
    // 旧版的 `settings` 墓碑不能解释为“删除全部配置”。
    if (!payload.logicalKey.startsWith('setting:')) return
    const key = payload.logicalKey.slice('setting:'.length)
    const store = await Store.load('store.json')
    const excludeSensitiveConfig = await store.get<boolean>('excludeSensitiveConfig') !== false
    if (!shouldExcludeFromSync(key, { excludeSensitiveConfig })) {
      await store.delete(key)
      await store.save()
      await import('@/stores/setting').then(module => module.default.getState().initSettingData())
    }
  }
  else if (payload.kind === 'conversation') {
    const snapshot: NoteGenServerConversationSnapshot = {
      schemaVersion: 1,
      type: 'conversation-snapshot',
      items: [],
      tombstones: [{
        entityType: 'conversation',
        syncId: id,
        conversationSyncId: id,
        deletedAt: payload.deletedAt,
      }],
    }
    await import('./conversation-sync').then(module => module.applyNoteGenServerConversationSnapshot(snapshot))
  }
  else if (payload.kind === 'memory') {
    await import('@/db/memories').then(module => module.permanentlyDeleteMemory(id))
  }
}

function logicalKeyForPayload(payload: Exclude<AppDataPayload, DeletePayload>): string {
  if (payload.type === 'setting') return `setting:${payload.key}`
  if (payload.type === 'settings') return 'workspace-preferences'
  if (payload.type === 'conversation') return `conversation:${payload.value.syncId}`
  if (payload.type === 'memory') return `memory:${payload.value.id}`
  if (payload.type === 'tag' || payload.type === 'mark') {
    const value = payload.value
    const identity = value.syncId ?? ('id' in value ? value.id : null)
    if (typeof identity !== 'string' && typeof identity !== 'number') {
      throw new Error(`服务器 ${payload.type} 对象缺少稳定身份`)
    }
    return `${payload.type}:${identity}`
  }
  return `canvas:${payload.value.id}`
}

async function hashPayload(value: string): Promise<string> {
  const normalized = stableSerialize(stripNoteGenServerAssetTransportFields(JSON.parse(value) as unknown))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function cacheFileRecordForSync(mark: Mark): Promise<string | null> {
  if (mark.type !== 'file' || !mark.url) return null
  if (mark.url.replace(/\\/g, '/').startsWith('record-files/')) return mark.url.replace(/\\/g, '/')
  if (!mark.syncId || (!mark.url.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(mark.url))) return null
  const fs = await import('@tauri-apps/plugin-fs')
  if (!await fs.exists(mark.url)) return null
  const fileName = mark.url.replace(/\\/g, '/').split('/').pop()?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment.bin'
  const directory = `record-files/${mark.syncId}`
  const localPath = `${directory}/${fileName}`
  if (!await fs.exists(localPath, { baseDir: fs.BaseDirectory.AppData })) {
    await fs.mkdir(directory, { baseDir: fs.BaseDirectory.AppData, recursive: true })
    await fs.writeFile(localPath, await fs.readFile(mark.url), { baseDir: fs.BaseDirectory.AppData })
  }
  return localPath
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function omitKeys<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const result = { ...value }
  for (const key of keys) Reflect.deleteProperty(result, key)
  return result
}
