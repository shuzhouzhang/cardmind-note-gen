import { getDb } from './index'
import { invoke } from '@tauri-apps/api/core'
import {
  isSyncV2FullyConverged,
  type SyncV2HealthSnapshot,
} from '@/lib/sync/sync-health'

export { isSyncV2FullyConverged, type SyncV2HealthSnapshot }

export type SyncV2InboxStatus = 'pending' | 'applied' | 'failed'
export type SyncV2ConflictStatus = 'unresolved' | 'resolved'

export interface SyncV2Entity {
  scopeId: string
  objectId: string
  kind: string
  localKey: string
  parentObjectId: string | null
  name: string | null
  lifecycleRevision: string
  documentId: string | null
  documentSequence: string
  materializedHash: string | null
  basePayloadJson: string | null
  deleted: number
}

export interface SyncV2OutboxEntry {
  id: number
  scopeId: string
  commandId: string
  commandType: string
  objectId: string | null
  documentId: string | null
  commandJson: string
  attempts: number
  blocked: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface RecoverableSyncV2Mutation {
  mutationId: string
  objectId: string | null
  kind: string
  payloadJson: string
  state: 'pending' | 'materialized' | 'queued' | 'failed'
  createdAt: number
}

export interface SyncV2Conflict {
  scopeId: string
  conflictId: string
  objectId: string
  kind: string
  type: string
  status: SyncV2ConflictStatus
  createdSequence: string
  payloadJson: string
  createdAt: number
  resolvedAt: number | null
}

export interface SyncV2ProblemDetail {
  category: 'outbox' | 'inbox' | 'transfer'
  operation: string
  objectId: string | null
  identity: string
  lastError: string | null
}

export interface SyncV2BootstrapProgress {
  bootstrapId: string
  snapshotSequence: string
  afterObjectId: string | null
}

export async function initNoteGenServerSyncV2Db(): Promise<void> {
  const db = await getDb()
  await db.execute(`
    create table if not exists sync_v2_state (
      scopeId text primary key,
      receivedCursor text not null default '0',
      latestServerSequence text not null default '0',
      lastSuccessfulSyncAt integer default null,
      lastServerConfirmedAt integer default null,
      lastFullyConvergedAt integer default null,
      updatedAt integer not null
    )
  `)
  await db.execute(`
    create table if not exists sync_v2_entities (
      scopeId text not null,
      objectId text not null,
      kind text not null,
      localKey text not null,
      parentObjectId text default null,
      name text default null,
      lifecycleRevision text not null default '0',
      documentId text default null,
      documentSequence text not null default '0',
      materializedHash text default null,
      basePayloadJson text default null,
      deleted integer not null default 0,
      updatedAt integer not null,
      primary key (scopeId, objectId),
      unique (scopeId, localKey)
    )
  `)
  try {
    await db.execute('alter table sync_v2_entities add column basePayloadJson text default null')
  } catch {
    // Idempotent migration.
  }
  await db.execute(`
    create table if not exists sync_v2_outbox (
      id integer primary key autoincrement,
      scopeId text not null,
      commandId text not null,
      commandType text not null,
      objectId text default null,
      documentId text default null,
      commandJson text not null,
      attempts integer not null default 0,
      blocked integer not null default 0,
      lastError text default null,
      createdAt integer not null,
      updatedAt integer not null,
      unique (scopeId, commandId)
    )
  `)
  await db.execute(`
    create index if not exists idx_sync_v2_outbox_scope_created
    on sync_v2_outbox(scopeId, blocked, createdAt)
  `)
  await db.execute(`
    create table if not exists sync_v2_inbox (
      id integer primary key autoincrement,
      scopeId text not null,
      eventId text not null,
      sequence text not null,
      eventType text not null,
      objectId text default null,
      documentId text default null,
      eventJson text not null,
      status text not null default 'pending' check(status in ('pending', 'applied', 'failed')),
      attempts integer not null default 0,
      lastError text default null,
      receivedAt integer not null,
      appliedAt integer default null,
      unique (scopeId, eventId),
      unique (scopeId, sequence)
    )
  `)
  await db.execute(`
    create table if not exists sync_v2_apply_journal (
      scopeId text not null,
      eventId text not null,
      eventJson text not null,
      attempts integer not null default 0,
      startedAt integer not null,
      primary key(scopeId, eventId)
    )
  `)
  await db.execute(`
    create trigger if not exists sync_v2_inbox_applied_cleanup
    after update of status on sync_v2_inbox
    when new.status = 'applied'
    begin
      delete from sync_v2_apply_journal
      where scopeId = new.scopeId and eventId = new.eventId;
    end
  `)
  await db.execute(`
    create index if not exists idx_sync_v2_inbox_scope_status
    on sync_v2_inbox(scopeId, status, sequence)
  `)
  await db.execute(`
    create table if not exists sync_v2_conflicts (
      scopeId text not null,
      conflictId text not null,
      objectId text not null,
      kind text not null,
      type text not null,
      status text not null default 'unresolved' check(status in ('unresolved', 'resolved')),
      createdSequence text not null,
      payloadJson text not null,
      createdAt integer not null,
      resolvedAt integer default null,
      primary key (scopeId, conflictId)
    )
  `)
  await db.execute(`
    create index if not exists idx_sync_v2_conflicts_scope_status
    on sync_v2_conflicts(scopeId, status, createdAt)
  `)
  await db.execute(`
    create table if not exists sync_v2_transfers (
      scopeId text not null,
      transferId text not null,
      objectId text default null,
      blobId text default null,
      direction text not null check(direction in ('upload', 'download')),
      state text not null check(state in ('pending', 'running', 'complete', 'failed')),
      completedBytes text not null default '0',
      totalBytes text not null default '0',
      attempts integer not null default 0,
      lastError text default null,
      updatedAt integer not null,
      primary key (scopeId, transferId)
    )
  `)
  await db.execute(`
    create table if not exists sync_v2_resource_refs (
      scopeId text not null,
      ownerObjectId text not null,
      resourceObjectId text not null,
      localPath text not null,
      updatedAt integer not null,
      primary key (scopeId, ownerObjectId, resourceObjectId)
    )
  `)
  await db.execute(`
    create index if not exists idx_sync_v2_resource_refs_resource
    on sync_v2_resource_refs(scopeId, resourceObjectId)
  `)
  await db.execute(`
    create table if not exists sync_v2_mutation_journal (
      id integer primary key autoincrement,
      scopeId text not null,
      mutationId text not null,
      objectId text default null,
      kind text not null,
      payloadJson text not null,
      state text not null default 'pending' check(state in ('pending', 'materialized', 'queued', 'failed')),
      lastError text default null,
      createdAt integer not null,
      updatedAt integer not null,
      unique(scopeId, mutationId)
    )
  `)
  await db.execute(`
    create table if not exists sync_v2_documents (
      scopeId text not null,
      documentId text not null,
      objectId text not null,
      kind text not null,
      latestDocumentSequence text not null default '0',
      checkpointDocumentSequence text not null default '0',
      checkpointId text default null,
      checkpointKeyVersion integer default null,
      checkpointCiphertext text default null,
      checkpointCiphertextHash text default null,
      updatedAt integer not null,
      primary key(scopeId, documentId)
    )
  `)
  try { await db.execute('alter table sync_v2_state add column bootstrapComplete integer not null default 0') } catch {}
  try { await db.execute('alter table sync_v2_state add column bootstrapId text default null') } catch {}
  try { await db.execute('alter table sync_v2_state add column bootstrapSnapshotSequence text default null') } catch {}
  try { await db.execute('alter table sync_v2_state add column bootstrapAfterObjectId text default null') } catch {}
  try { await db.execute('alter table sync_v2_state add column lastServerConfirmedAt integer default null') } catch {}
  try { await db.execute('alter table sync_v2_state add column lastFullyConvergedAt integer default null') } catch {}
}

export interface LocalSyncV2Document {
  scopeId: string
  documentId: string
  objectId: string
  kind: string
  latestDocumentSequence: string
  checkpointDocumentSequence: string
  checkpointId: string | null
  checkpointKeyVersion: number | null
  checkpointCiphertext: string | null
  checkpointCiphertextHash: string | null
}

export async function beginSyncV2EventApply(scopeId: string, eventId: string, eventJson: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_apply_journal(scopeId, eventId, eventJson, attempts, startedAt)
     values($1, $2, $3, 1, $4)
     on conflict(scopeId, eventId) do update set
       eventJson = excluded.eventJson, attempts = sync_v2_apply_journal.attempts + 1,
       startedAt = excluded.startedAt`,
    [scopeId, eventId, eventJson, Date.now()],
  )
}

export async function recoverSyncV2ApplyJournal(scopeId: string): Promise<number> {
  const db = await getDb()
  const rows = await db.select<Array<{ eventId: string, eventJson: string }>>(
    `select journal.eventId, journal.eventJson from sync_v2_apply_journal journal
     left join sync_v2_inbox inbox on inbox.scopeId=journal.scopeId and inbox.eventId=journal.eventId
     where journal.scopeId=$1 and (inbox.eventId is null or inbox.status != 'applied')`,
    [scopeId],
  )
  for (const row of rows) {
    const event = JSON.parse(row.eventJson) as {
      eventId: string, sequence: string, type: string,
      objectId?: string | null, documentId?: string | null,
    }
    await storeSyncV2Event(scopeId, event)
  }
  await applySyncV2AtomicBatch([
    {
      statement: `delete from sync_v2_apply_journal where scopeId=$1 and exists(
        select 1 from sync_v2_inbox where scopeId=$1
          and eventId=sync_v2_apply_journal.eventId and status='applied')`,
      values: [scopeId],
    },
  ])
  return rows.length
}

export async function listRecoverableSyncV2Mutations(scopeId: string): Promise<RecoverableSyncV2Mutation[]> {
  const db = await getDb()
  return db.select<RecoverableSyncV2Mutation[]>(
    `select mutationId,objectId,kind,payloadJson,state,createdAt
     from sync_v2_mutation_journal where scopeId=$1 and state in ('pending','materialized','failed')
     order by createdAt`,
    [scopeId],
  )
}

export async function isSyncV2BootstrapComplete(scopeId: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select<Array<{ bootstrapComplete: number }>>(
    'select bootstrapComplete from sync_v2_state where scopeId = $1 limit 1', [scopeId],
  )
  return rows[0]?.bootstrapComplete === 1
}

export async function getSyncV2BootstrapProgress(scopeId: string): Promise<SyncV2BootstrapProgress | null> {
  const db = await getDb()
  const rows = await db.select<Array<{
    bootstrapId: string | null
    bootstrapSnapshotSequence: string | null
    bootstrapAfterObjectId: string | null
  }>>(
    `select bootstrapId, bootstrapSnapshotSequence, bootstrapAfterObjectId
     from sync_v2_state where scopeId = $1 limit 1`,
    [scopeId],
  )
  const row = rows[0]
  if (!row?.bootstrapId || !row.bootstrapSnapshotSequence) return null
  return {
    bootstrapId: row.bootstrapId,
    snapshotSequence: row.bootstrapSnapshotSequence,
    afterObjectId: row.bootstrapAfterObjectId,
  }
}

export async function saveSyncV2BootstrapProgress(
  scopeId: string,
  progress: SyncV2BootstrapProgress,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_state(
       scopeId, receivedCursor, latestServerSequence, updatedAt, bootstrapComplete,
       bootstrapId, bootstrapSnapshotSequence, bootstrapAfterObjectId
     ) values($1, '0', '0', $5, 0, $2, $3, $4)
     on conflict(scopeId) do update set
       bootstrapId = excluded.bootstrapId,
       bootstrapSnapshotSequence = excluded.bootstrapSnapshotSequence,
       bootstrapAfterObjectId = excluded.bootstrapAfterObjectId,
       bootstrapComplete = 0,
       updatedAt = excluded.updatedAt`,
    [scopeId, progress.bootstrapId, progress.snapshotSequence, progress.afterObjectId, Date.now()],
  )
}

export async function clearSyncV2BootstrapProgress(scopeId: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_state set bootstrapId = null, bootstrapSnapshotSequence = null,
       bootstrapAfterObjectId = null, updatedAt = $2 where scopeId = $1`,
    [scopeId, Date.now()],
  )
}

export async function markSyncV2BootstrapComplete(scopeId: string, snapshotSequence: string): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `insert into sync_v2_state(scopeId, receivedCursor, latestServerSequence, lastSuccessfulSyncAt, updatedAt,
       bootstrapComplete, bootstrapId, bootstrapSnapshotSequence, bootstrapAfterObjectId)
     values($1, $2, $2, null, $3, 1, null, null, null)
     on conflict(scopeId) do update set receivedCursor = excluded.receivedCursor,
       latestServerSequence = excluded.latestServerSequence, bootstrapComplete = 1,
       bootstrapId = null, bootstrapSnapshotSequence = null, bootstrapAfterObjectId = null,
       updatedAt = excluded.updatedAt`,
    [scopeId, snapshotSequence, now],
  )
}

export async function upsertLocalSyncV2Document(document: LocalSyncV2Document): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_documents(scopeId, documentId, objectId, kind, latestDocumentSequence,
       checkpointDocumentSequence, checkpointId, checkpointKeyVersion, checkpointCiphertext,
       checkpointCiphertextHash, updatedAt)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict(scopeId, documentId) do update set objectId=excluded.objectId, kind=excluded.kind,
       latestDocumentSequence=excluded.latestDocumentSequence,
       checkpointDocumentSequence=excluded.checkpointDocumentSequence,
       checkpointId=excluded.checkpointId, checkpointKeyVersion=excluded.checkpointKeyVersion,
       checkpointCiphertext=excluded.checkpointCiphertext,
       checkpointCiphertextHash=excluded.checkpointCiphertextHash, updatedAt=excluded.updatedAt`,
    [document.scopeId, document.documentId, document.objectId, document.kind,
      document.latestDocumentSequence, document.checkpointDocumentSequence, document.checkpointId,
      document.checkpointKeyVersion, document.checkpointCiphertext, document.checkpointCiphertextHash, Date.now()],
  )
}

export async function getLocalSyncV2Document(scopeId: string, documentId: string): Promise<LocalSyncV2Document | null> {
  const db = await getDb()
  const rows = await db.select<LocalSyncV2Document[]>(
    'select * from sync_v2_documents where scopeId = $1 and documentId = $2 limit 1',
    [scopeId, documentId],
  )
  return rows[0] ?? null
}

export async function getSyncV2EntityByLocalKey(scopeId: string, localKey: string): Promise<SyncV2Entity | null> {
  const db = await getDb()
  const rows = await db.select<SyncV2Entity[]>(
    'select * from sync_v2_entities where scopeId = $1 and localKey = $2 limit 1',
    [scopeId, localKey],
  )
  return rows[0] ?? null
}

export async function getSyncV2AssetEntityByPath(
  scopeId: string,
  localPath: string,
  assetScope: 'appData' | 'workspace',
  contentHash: string,
): Promise<SyncV2Entity | null> {
  const db = await getDb()
  const rows = await db.select<SyncV2Entity[]>(
    `select entity.* from sync_v2_entities entity
     where entity.scopeId = $1 and entity.kind = 'asset' and entity.name = $2
     order by entity.deleted asc, entity.updatedAt desc`,
    [scopeId, `${assetScope}:${localPath}`],
  )
  return rows.find(row => {
    if (!row.basePayloadJson) return row.lifecycleRevision === '0'
    try {
      return (JSON.parse(row.basePayloadJson) as { contentHash?: unknown }).contentHash === contentHash
    } catch {
      return false
    }
  }) ?? null
}

export async function getSyncV2AssetEntityForOwnerPath(
  scopeId: string,
  ownerObjectId: string,
  localPath: string,
): Promise<SyncV2Entity | null> {
  const db = await getDb()
  const rows = await db.select<SyncV2Entity[]>(
    `select entity.* from sync_v2_resource_refs resource
     join sync_v2_entities entity on entity.scopeId = resource.scopeId
       and entity.objectId = resource.resourceObjectId
     where resource.scopeId = $1 and resource.ownerObjectId = $2
       and resource.localPath = $3 and entity.kind = 'asset'
     limit 1`,
    [scopeId, ownerObjectId, localPath],
  )
  return rows[0] ?? null
}

export async function listUnreferencedSyncV2AssetEntities(
  scopeId: string,
  updatedBefore: number,
  limit = 100,
): Promise<SyncV2Entity[]> {
  const db = await getDb()
  return db.select<SyncV2Entity[]>(
    `select entity.* from sync_v2_entities entity
     where entity.scopeId = $1 and entity.kind = 'asset' and entity.deleted = 0
       and entity.lifecycleRevision <> '0' and entity.updatedAt < $2
       and not exists (
         select 1 from sync_v2_resource_refs resource
         where resource.scopeId = entity.scopeId
           and resource.resourceObjectId = entity.objectId
       )
       and not exists (
         select 1 from sync_v2_outbox outbox
         where outbox.scopeId = entity.scopeId and outbox.objectId = entity.objectId
       )
     order by entity.updatedAt limit $3`,
    [scopeId, updatedBefore, limit],
  )
}

export async function listRetiredSyncV2Entities(
  scopeId: string,
  limit = 50,
): Promise<SyncV2Entity[]> {
  const db = await getDb()
  return db.select<SyncV2Entity[]>(
    `select * from sync_v2_entities
     where scopeId = $1 and deleted = 1 and lifecycleRevision <> '0'
       and localKey like '__sync_replaced__/%'
       and coalesce(json_extract(basePayloadJson, '$.retiredIdentity'), 0) <> 1
     order by updatedAt, objectId limit $2`,
    [scopeId, Math.max(1, Math.min(200, Math.trunc(limit)))],
  )
}

export async function getSyncV2Entity(scopeId: string, objectId: string): Promise<SyncV2Entity | null> {
  const db = await getDb()
  const rows = await db.select<SyncV2Entity[]>(
    'select * from sync_v2_entities where scopeId = $1 and objectId = $2 limit 1',
    [scopeId, objectId],
  )
  return rows[0] ?? null
}

export async function listSyncV2SubtreeEntities(scopeId: string, rootObjectId: string): Promise<SyncV2Entity[]> {
  const db = await getDb()
  return db.select<SyncV2Entity[]>(
    `with recursive subtree(objectId) as (
       select objectId from sync_v2_entities where scopeId = $1 and objectId = $2
       union all
       select entity.objectId from sync_v2_entities entity
       join subtree parent on entity.parentObjectId = parent.objectId
       where entity.scopeId = $1 and entity.deleted = 0
     )
     select entity.* from sync_v2_entities entity
     join subtree on subtree.objectId = entity.objectId
     where entity.scopeId = $1 and entity.deleted = 0`,
    [scopeId, rootObjectId],
  )
}

export async function listSyncV2CrdtEntitiesNeedingMaterialization(
  scopeId: string,
  limit = 50,
): Promise<SyncV2Entity[]> {
  const db = await getDb()
  return db.select<SyncV2Entity[]>(
    `select * from sync_v2_entities
     where scopeId = $1 and deleted = 0 and documentId is not null
       and kind in ('note', 'tag', 'mark', 'canvas', 'conversation', 'memory', 'setting')
       and json_extract(basePayloadJson, '$.type') = 'crdt-object'
       and coalesce(materializedHash, '') != ('crdt:' || documentSequence)
     order by updatedAt, objectId limit $2`,
    [scopeId, Math.max(1, Math.min(200, Math.trunc(limit)))],
  )
}

export async function listSyncV2StructuredSnapshotsMissingLocally(
  scopeId: string,
  limit = 100,
): Promise<SyncV2Entity[]> {
  const db = await getDb()
  return db.select<SyncV2Entity[]>(
    `select entity.* from sync_v2_entities entity
     where entity.scopeId = $1 and entity.deleted = 0 and entity.basePayloadJson is not null
       and json_extract(entity.basePayloadJson, '$.type') in
         ('tag', 'mark', 'canvas', 'conversation', 'memory')
       and (
         (entity.kind = 'tag' and not exists (
           select 1 from tags where tags.syncId = json_extract(entity.basePayloadJson, '$.value.syncId')
         )) or
         (entity.kind = 'mark' and not exists (
           select 1 from marks where marks.syncId = json_extract(entity.basePayloadJson, '$.value.syncId')
         )) or
         (entity.kind = 'canvas' and not exists (
           select 1 from canvases where canvases.id = json_extract(entity.basePayloadJson, '$.value.id')
         )) or
         (entity.kind = 'conversation' and not exists (
           select 1 from conversations where conversations.syncId = json_extract(entity.basePayloadJson, '$.value.syncId')
         )) or
         (entity.kind = 'memory' and not exists (
           select 1 from memories where memories.id = json_extract(entity.basePayloadJson, '$.value.id')
         ))
       )
     order by case entity.kind when 'tag' then 0 when 'mark' then 1 else 2 end,
       entity.updatedAt, entity.objectId limit $2`,
    [scopeId, Math.max(1, Math.min(500, Math.trunc(limit)))],
  )
}

export async function markSyncV2EntityDocumentMaterialized(
  scopeId: string,
  objectId: string,
  documentSequence: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_entities set materializedHash = $4, updatedAt = $5
     where scopeId = $1 and objectId = $2 and documentSequence = $3`,
    [scopeId, objectId, documentSequence, `crdt:${documentSequence}`, Date.now()],
  )
}

export async function moveSyncV2EntityLocalKey(scopeId: string, oldKey: string, newKey: string): Promise<boolean> {
  const db = await getDb()
  const segments = newKey.split('/').filter(Boolean)
  const parentKey = segments.length > 1 ? segments.slice(0, -1).join('/') : null
  const parent = parentKey === null ? null : await getOrCreateSyncV2Entity({
    scopeId, kind: 'folder', localKey: parentKey,
  })
  const parentObjectId = parent?.objectId ?? null
  const result = await db.execute(
    `update sync_v2_entities set
       localKey = case when localKey = $2 then $3 else $3 || substr(localKey, length($2) + 1) end,
       name = case when localKey = $2 then $4 else name end,
       parentObjectId = case when localKey = $2 then $5 else parentObjectId end,
       updatedAt = $6
     where scopeId = $1 and (localKey = $2 or localKey like $2 || '/%')`,
    [scopeId, oldKey, newKey, segments.at(-1) ?? newKey, parentObjectId, Date.now()],
  )
  return result.rowsAffected > 0
}

export async function upsertSyncV2Entity(entity: SyncV2Entity): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_entities (
       scopeId, objectId, kind, localKey, parentObjectId, name, lifecycleRevision,
       documentId, documentSequence, materializedHash, basePayloadJson, deleted, updatedAt
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict(scopeId, objectId) do update set
       kind = excluded.kind, localKey = excluded.localKey,
       parentObjectId = excluded.parentObjectId, name = excluded.name,
       lifecycleRevision = excluded.lifecycleRevision, documentId = excluded.documentId,
       documentSequence = excluded.documentSequence, materializedHash = excluded.materializedHash,
       basePayloadJson = excluded.basePayloadJson, deleted = excluded.deleted,
       updatedAt = excluded.updatedAt`,
    [entity.scopeId, entity.objectId, entity.kind, entity.localKey, entity.parentObjectId,
      entity.name, entity.lifecycleRevision, entity.documentId, entity.documentSequence,
      entity.materializedHash, entity.basePayloadJson, entity.deleted, Date.now()],
  )
}

/**
 * Retires a local identity after the same logical object has acquired its
 * authoritative server identity. The row is retained under a reserved key for
 * diagnostics, while commands that could recreate the superseded object are
 * removed atomically.
 */
export async function retireSyncV2EntityIdentity(
  scopeId: string,
  objectId: string,
  replacementObjectId: string,
): Promise<void> {
  if (objectId === replacementObjectId) return
  const replacementKey = `__sync_replaced__/${objectId}`
  await applySyncV2AtomicBatch([
    {
      statement: `update sync_v2_entities set localKey=$3, deleted=1, updatedAt=$4
        where scopeId=$1 and objectId=$2`,
      values: [scopeId, objectId, replacementKey, Date.now()],
    },
    {
      statement: 'delete from sync_v2_outbox where scopeId=$1 and objectId=$2',
      values: [scopeId, objectId],
    },
    {
      statement: 'delete from sync_v2_mutation_journal where scopeId=$1 and objectId=$2',
      values: [scopeId, objectId],
    },
    {
      statement: 'delete from note_gen_server_sync_outbox where workspaceId=$1 and objectId=$2',
      values: [scopeId, objectId],
    },
    {
      statement: 'delete from note_gen_server_sync_objects where workspaceId=$1 and objectId=$2',
      values: [scopeId, objectId],
    },
  ])
}

export async function getOrCreateSyncV2Entity(input: {
  scopeId: string
  kind: string
  localKey: string
  objectId?: string
  stableWorkspaceId?: string
}): Promise<SyncV2Entity> {
  const existing = await getSyncV2EntityByLocalKey(input.scopeId, input.localKey)
  const stableObjectId = input.stableWorkspaceId
    ? await deterministicSyncV2ObjectId(input.stableWorkspaceId, input.kind, input.localKey)
    : null
  if (existing && (!stableObjectId || existing.objectId === stableObjectId)) return existing
  if (existing && stableObjectId) {
    await retireSyncV2EntityIdentity(input.scopeId, existing.objectId, stableObjectId)
  }
  const objectId = input.objectId ?? stableObjectId ?? crypto.randomUUID()
  const segments = input.localKey.split('/').filter(Boolean)
  const parentPath = ['note', 'folder'].includes(input.kind) && segments.length > 1
    ? segments.slice(0, -1).join('/') : null
  const parent = parentPath
    ? await getOrCreateSyncV2Entity({
        scopeId: input.scopeId, kind: 'folder', localKey: parentPath,
        stableWorkspaceId: input.stableWorkspaceId,
      })
    : null
  const entity: SyncV2Entity = {
    scopeId: input.scopeId,
    objectId,
    kind: input.kind,
    localKey: input.localKey,
    parentObjectId: parent?.objectId ?? null,
    name: segments.at(-1) ?? input.localKey,
    lifecycleRevision: '0',
    documentId: ['note', 'mark', 'canvas', 'conversation', 'memory', 'setting'].includes(input.kind)
      ? `${input.kind}:${objectId}`
      : null,
    documentSequence: '0',
    materializedHash: null,
    basePayloadJson: null,
    deleted: 0,
  }
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_entities(scopeId,objectId,kind,localKey,parentObjectId,name,
       lifecycleRevision,documentId,documentSequence,materializedHash,basePayloadJson,deleted,updatedAt)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict do nothing`,
    [entity.scopeId, entity.objectId, entity.kind, entity.localKey, entity.parentObjectId,
      entity.name, entity.lifecycleRevision, entity.documentId, entity.documentSequence,
      entity.materializedHash, entity.basePayloadJson, entity.deleted, Date.now()],
  )
  return await getSyncV2Entity(input.scopeId, objectId) ?? entity
}

async function deterministicSyncV2ObjectId(
  workspaceId: string,
  kind: string,
  localKey: string,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${workspaceId}\0${kind}\0${localKey}`),
  )).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function enqueueSyncV2Command(input: {
  scopeId: string
  command: { commandId: string, type: string, objectId?: string, documentId?: string }
    & Record<string, unknown>
}): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `insert into sync_v2_outbox (
       scopeId, commandId, commandType, objectId, documentId, commandJson,
       attempts, blocked, lastError, createdAt, updatedAt
     ) values ($1, $2, $3, $4, $5, $6, 0, 0, null, $7, $7)
     on conflict(scopeId, commandId) do nothing`,
    [input.scopeId, input.command.commandId, input.command.type,
      input.command.objectId ?? null, input.command.documentId ?? null,
      JSON.stringify(input.command), now],
  )
}

export async function listSyncV2Outbox(
  scopeId: string,
  limit = 100,
  options: { includeBlocked?: boolean } = {},
): Promise<SyncV2OutboxEntry[]> {
  const db = await getDb()
  return db.select<SyncV2OutboxEntry[]>(
    `select * from sync_v2_outbox where scopeId = $1
       ${options.includeBlocked ? '' : 'and blocked = 0'}
     order by createdAt, id limit $2`,
    [scopeId, limit],
  )
}

export async function completeSyncV2Command(scopeId: string, commandId: string): Promise<void> {
  const db = await getDb()
  await db.execute('delete from sync_v2_outbox where scopeId = $1 and commandId = $2', [scopeId, commandId])
}

export async function failSyncV2Command(scopeId: string, commandId: string, error: string, blocked: boolean): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_outbox set attempts = attempts + 1, blocked = $3, lastError = $4, updatedAt = $5
     where scopeId = $1 and commandId = $2`,
    [scopeId, commandId, blocked ? 1 : 0, error.slice(0, 2_000), Date.now()],
  )
}

export async function replaceReusedSyncV2Command(
  scopeId: string,
  entry: SyncV2OutboxEntry,
): Promise<boolean> {
  try {
    const command = JSON.parse(entry.commandJson) as Record<string, unknown>
    if (command.commandId !== entry.commandId || command.type !== entry.commandType) return false
    const replacementId = crypto.randomUUID()
    const mutationIds = new Set(
      Array.isArray(command.mutationIds)
        ? command.mutationIds.filter((value): value is string => typeof value === 'string')
        : [],
    )
    mutationIds.add(entry.commandId)
    command.commandId = replacementId
    command.mutationIds = Array.from(mutationIds)
    const db = await getDb()
    const result = await db.execute(
      `update sync_v2_outbox set commandId = $3, commandJson = $4,
         attempts = 0, blocked = 0, lastError = null, updatedAt = $5
       where scopeId = $1 and commandId = $2`,
      [scopeId, entry.commandId, replacementId, JSON.stringify(command), Date.now()],
    )
    return result.rowsAffected > 0
  } catch {
    return false
  }
}

/**
 * A delete based on an older lifecycle revision is safe to retry against the
 * revision reported by the server. The document-sequence precondition remains
 * unchanged, so a concurrent content edit still becomes a typed
 * delete-vs-edit conflict instead of being discarded.
 */
export async function rebaseSyncV2DeleteCommand(
  scopeId: string,
  entry: SyncV2OutboxEntry,
  revision: string,
): Promise<boolean> {
  if (!/^\d+$/.test(revision)) return false
  try {
    const command = JSON.parse(entry.commandJson) as Record<string, unknown>
    if (command.commandId !== entry.commandId
      || command.type !== 'delete-object'
      || entry.commandType !== 'delete-object') return false
    const replacementId = crypto.randomUUID()
    const mutationIds = new Set(
      Array.isArray(command.mutationIds)
        ? command.mutationIds.filter((value): value is string => typeof value === 'string')
        : [],
    )
    mutationIds.add(entry.commandId)
    command.commandId = replacementId
    command.baseRevision = revision
    command.mutationIds = Array.from(mutationIds)
    const db = await getDb()
    const result = await db.execute(
      `update sync_v2_outbox set commandId = $3, commandJson = $4,
         attempts = attempts + 1, blocked = 0, lastError = null, updatedAt = $5
       where scopeId = $1 and commandId = $2`,
      [scopeId, entry.commandId, replacementId, JSON.stringify(command), Date.now()],
    )
    return result.rowsAffected > 0
  } catch {
    return false
  }
}

export async function storeSyncV2Event(scopeId: string, event: {
  eventId: string
  sequence: string
  type: string
  objectId?: string | null
  documentId?: string | null
}): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_inbox (
       scopeId, eventId, sequence, eventType, objectId, documentId, eventJson,
       status, attempts, lastError, receivedAt, appliedAt
     ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, null, $8, null)
     on conflict(scopeId, eventId) do nothing`,
    [scopeId, event.eventId, event.sequence, event.type, event.objectId ?? null,
      event.documentId ?? null, JSON.stringify(event), Date.now()],
  )
}

export async function listUnappliedSyncV2Events(scopeId: string, limit = 500): Promise<Array<{
  id: number
  eventId: string
  sequence: string
  eventType: string
  eventJson: string
  status: SyncV2InboxStatus
}>> {
  const db = await getDb()
  return db.select(
    `select id, eventId, sequence, eventType, eventJson, status from sync_v2_inbox
     where scopeId = $1 and status != 'applied' order by cast(sequence as integer), id limit $2`,
    [scopeId, Math.max(1, Math.min(500, Math.trunc(limit)))],
  )
}

export async function completeSyncV2Event(scopeId: string, eventId: string): Promise<void> {
  await applySyncV2AtomicBatch([
    {
      statement: `update sync_v2_inbox set status = 'applied', lastError = null, appliedAt = $3
        where scopeId = $1 and eventId = $2`,
      values: [scopeId, eventId, Date.now()],
    },
    {
      statement: 'delete from sync_v2_apply_journal where scopeId = $1 and eventId = $2',
      values: [scopeId, eventId],
    },
  ])
}

export interface SyncV2AtomicStatement {
  statement: string
  values?: unknown[]
}

/** Runs every supplied mutation on one native SQLite connection and transaction. */
export async function applySyncV2AtomicBatch(operations: SyncV2AtomicStatement[]): Promise<number> {
  const result = await invoke<{ rowsAffected: number }>('apply_sync_atomic_batch', { operations })
  return result.rowsAffected
}

export async function failSyncV2Event(scopeId: string, eventId: string, error: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_inbox set status = 'failed', attempts = attempts + 1, lastError = $3
     where scopeId = $1 and eventId = $2`,
    [scopeId, eventId, error.slice(0, 2_000)],
  )
}

export async function deferSyncV2Event(scopeId: string, eventId: string, reason: string): Promise<void> {
  await applySyncV2AtomicBatch([
    {
      statement: `update sync_v2_inbox set status = 'pending', lastError = $3
        where scopeId = $1 and eventId = $2`,
      values: [scopeId, eventId, reason.slice(0, 2_000)],
    },
    {
      statement: 'delete from sync_v2_apply_journal where scopeId = $1 and eventId = $2',
      values: [scopeId, eventId],
    },
  ])
}

export async function updateSyncV2Cursor(
  scopeId: string,
  receivedCursor: string,
  latestServerSequence: string,
): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `insert into sync_v2_state (
       scopeId, receivedCursor, latestServerSequence, lastSuccessfulSyncAt, updatedAt
     ) values ($1, $2, $3, null, $4)
     on conflict(scopeId) do update set
       receivedCursor = excluded.receivedCursor,
       latestServerSequence = excluded.latestServerSequence,
       updatedAt = excluded.updatedAt`,
    [scopeId, receivedCursor, latestServerSequence, now],
  )
}

export async function markSyncV2Successful(scopeId: string): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `update sync_v2_state set lastSuccessfulSyncAt = $2,
       lastFullyConvergedAt = $2, updatedAt = $2 where scopeId = $1`,
    [scopeId, now],
  )
}

export async function markSyncV2ServerConfirmed(scopeId: string): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `update sync_v2_state set lastServerConfirmedAt = $2, updatedAt = $2 where scopeId = $1`,
    [scopeId, now],
  )
  const cutoff = now - 7 * 24 * 60 * 60_000
  await db.execute(
    `delete from sync_v2_inbox where scopeId = $1 and status = 'applied' and appliedAt < $2`,
    [scopeId, cutoff],
  )
  await db.execute(
    `delete from sync_v2_transfers where scopeId = $1 and state = 'complete' and updatedAt < $2`,
    [scopeId, cutoff],
  )
}

export async function upsertSyncV2Conflict(conflict: SyncV2Conflict): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_conflicts (
       scopeId, conflictId, objectId, kind, type, status, createdSequence,
       payloadJson, createdAt, resolvedAt
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict(scopeId, conflictId) do update set
       status = excluded.status, createdSequence = excluded.createdSequence,
       payloadJson = excluded.payloadJson,
       resolvedAt = excluded.resolvedAt`,
    [conflict.scopeId, conflict.conflictId, conflict.objectId, conflict.kind, conflict.type,
      conflict.status, conflict.createdSequence, conflict.payloadJson, conflict.createdAt, conflict.resolvedAt],
  )
}

export async function listSyncV2Conflicts(scopeId: string): Promise<SyncV2Conflict[]> {
  const db = await getDb()
  return db.select<SyncV2Conflict[]>(
    `select * from sync_v2_conflicts where scopeId = $1 and status = 'unresolved' order by createdAt`,
    [scopeId],
  )
}

export async function listOrphanedLocalSyncV2Conflicts(
  scopeId: string,
  limit = 50,
): Promise<SyncV2Conflict[]> {
  const db = await getDb()
  return db.select<SyncV2Conflict[]>(
    `select conflict.* from sync_v2_conflicts conflict
     where conflict.scopeId = $1 and conflict.status = 'unresolved'
       and conflict.createdSequence = '0'
       and not exists (
         select 1 from sync_v2_outbox outbox
         where outbox.scopeId = conflict.scopeId and outbox.commandType = 'create-conflict'
           and outbox.blocked = 0
           and json_extract(outbox.commandJson, '$.conflictId') = conflict.conflictId
       )
     order by conflict.createdAt limit $2`,
    [scopeId, Math.max(1, Math.min(200, Math.trunc(limit)))],
  )
}

export async function retireBlockedSyncV2ConflictCommand(
  scopeId: string,
  conflictId: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `delete from sync_v2_outbox where scopeId = $1 and commandType = 'create-conflict'
       and blocked = 1 and json_extract(commandJson, '$.conflictId') = $2`,
    [scopeId, conflictId],
  )
}

export async function getSyncV2Conflict(scopeId: string, conflictId: string): Promise<SyncV2Conflict | null> {
  const db = await getDb()
  const rows = await db.select<SyncV2Conflict[]>(
    `select * from sync_v2_conflicts where scopeId = $1 and conflictId = $2 limit 1`,
    [scopeId, conflictId],
  )
  return rows[0] ?? null
}

export async function hasUnresolvedSyncV2ConflictForObject(scopeId: string, objectId: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select<Array<{ present: number }>>(
    `select 1 as present from sync_v2_conflicts
     where scopeId = $1 and objectId = $2 and status = 'unresolved' limit 1`,
    [scopeId, objectId],
  )
  return rows.length > 0
}

export async function resolveLocalSyncV2Conflict(scopeId: string, conflictId: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_conflicts set status = 'resolved', resolvedAt = $3
     where scopeId = $1 and conflictId = $2`,
    [scopeId, conflictId, Date.now()],
  )
}

export async function getSyncV2HealthSnapshot(scopeId: string): Promise<SyncV2HealthSnapshot> {
  const db = await getDb()
  const rows = await db.select<SyncV2HealthSnapshot[]>(
    `select
       coalesce((select receivedCursor from sync_v2_state where scopeId = $1), '0') as receivedCursor,
       coalesce((select latestServerSequence from sync_v2_state where scopeId = $1), '0') as latestServerSequence,
       (select lastSuccessfulSyncAt from sync_v2_state where scopeId = $1) as lastSuccessfulSyncAt,
       (select lastServerConfirmedAt from sync_v2_state where scopeId = $1) as lastServerConfirmedAt,
       (select lastFullyConvergedAt from sync_v2_state where scopeId = $1) as lastFullyConvergedAt,
       (select count(*) from sync_v2_mutation_journal where scopeId = $1) as pendingMutations,
       (select count(*) from sync_v2_outbox where scopeId = $1 and blocked = 0) as pendingOutbox,
       (select count(*) from sync_v2_outbox where scopeId = $1 and blocked = 1) as blockedOutbox,
       (select count(*) from sync_v2_inbox where scopeId = $1 and status = 'pending') as pendingInbox,
       (select count(*) from sync_v2_inbox where scopeId = $1 and status = 'failed') as failedInbox,
       (select count(*) from sync_v2_conflicts where scopeId = $1 and status = 'unresolved') as unresolvedConflicts,
       (select count(*) from sync_v2_transfers where scopeId = $1 and state in ('pending', 'running')) as pendingTransfers,
       (select count(*) from sync_v2_transfers where scopeId = $1 and state = 'failed') as failedTransfers`,
    [scopeId],
  )
  return rows[0] ?? {
    receivedCursor: '0', latestServerSequence: '0', lastSuccessfulSyncAt: null,
    lastServerConfirmedAt: null, lastFullyConvergedAt: null,
    pendingMutations: 0, pendingOutbox: 0, blockedOutbox: 0, pendingInbox: 0, failedInbox: 0,
    unresolvedConflicts: 0, pendingTransfers: 0, failedTransfers: 0,
  }
}

export async function listSyncV2ProblemDetails(
  scopeId: string,
  limit = 20,
): Promise<SyncV2ProblemDetail[]> {
  const db = await getDb()
  return db.select<SyncV2ProblemDetail[]>(
    `select category, operation, objectId, identity, lastError from (
       select 'outbox' as category, commandType as operation, objectId,
         commandId as identity, lastError, updatedAt
       from sync_v2_outbox where scopeId = $1 and blocked = 1
       union all
       select 'inbox' as category, eventType as operation, objectId,
         eventId as identity, lastError, receivedAt as updatedAt
       from sync_v2_inbox where scopeId = $1 and status = 'failed'
       union all
       select 'transfer' as category, direction as operation, objectId,
         transferId as identity, lastError, updatedAt
       from sync_v2_transfers where scopeId = $1 and state = 'failed'
     ) problems order by updatedAt desc limit $2`,
    [scopeId, Math.max(1, Math.min(100, Math.trunc(limit)))],
  )
}

export async function getSyncV2ObjectStatus(scopeId: string, localKey: string): Promise<'conflict' | 'pending' | 'synced' | null> {
  const db = await getDb()
  const rows = await db.select<Array<{ objectId: string, pending: number, conflicts: number, issues: number }>>(
    `select entity.objectId,
       ((select count(*) from sync_v2_outbox outbox where outbox.scopeId = entity.scopeId
         and (outbox.objectId = entity.objectId or outbox.objectId in
           (select resourceObjectId from sync_v2_resource_refs resource
            where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId)))
        + (select count(*) from note_gen_server_sync_outbox legacy where legacy.workspaceId = entity.scopeId
          and legacy.objectId = entity.objectId)
       + (select count(*) from sync_v2_mutation_journal mutation where mutation.scopeId = entity.scopeId
          and mutation.objectId = entity.objectId)
        + (select count(*) from sync_v2_transfers transfer where transfer.scopeId = entity.scopeId
          and transfer.direction = 'upload' and transfer.state in ('pending','running') and
          (transfer.objectId = entity.objectId or transfer.objectId in
            (select resourceObjectId from sync_v2_resource_refs resource
             where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId)))) as pending,
       (select count(*) from sync_v2_conflicts conflict where conflict.scopeId = entity.scopeId
         and conflict.status = 'unresolved' and
         (conflict.objectId = entity.objectId or conflict.objectId in
           (select resourceObjectId from sync_v2_resource_refs resource
            where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId))) as conflicts,
       ((select count(*) from sync_v2_outbox blocked where blocked.scopeId = entity.scopeId
          and blocked.blocked = 1 and
          (blocked.objectId = entity.objectId or blocked.objectId in
            (select resourceObjectId from sync_v2_resource_refs resource
             where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId)))
        + (select count(*) from sync_v2_inbox failed where failed.scopeId = entity.scopeId
          and failed.status = 'failed' and
          (failed.objectId = entity.objectId or failed.objectId in
            (select resourceObjectId from sync_v2_resource_refs resource
             where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId)))
        + (select count(*) from sync_v2_transfers transfer where transfer.scopeId = entity.scopeId
          and transfer.state = 'failed' and
          (transfer.objectId = entity.objectId or transfer.objectId in
            (select resourceObjectId from sync_v2_resource_refs resource
             where resource.scopeId = entity.scopeId and resource.ownerObjectId = entity.objectId)))) as issues
     from sync_v2_entities entity where entity.scopeId = $1 and entity.localKey = $2 limit 1`,
    [scopeId, localKey],
  )
  const row = rows[0]
  if (!row) return null
  if (row.conflicts > 0 || row.issues > 0) return 'conflict'
  if (row.pending > 0) return 'pending'
  return 'synced'
}

export async function setSyncV2Transfer(input: {
  scopeId: string
  transferId: string
  objectId: string | null
  blobId?: string | null
  direction: 'upload' | 'download'
  state: 'pending' | 'running' | 'complete' | 'failed'
  completedBytes?: number
  totalBytes?: number
  error?: string | null
}): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into sync_v2_transfers(scopeId, transferId, objectId, blobId, direction, state,
       completedBytes, totalBytes, attempts, lastError, updatedAt)
     values($1,$2,$3,$4,$5,$6,$7,$8,case when $6='failed' then 1 else 0 end,$9,$10)
     on conflict(scopeId, transferId) do update set state=excluded.state,
       blobId=coalesce(excluded.blobId,sync_v2_transfers.blobId),
       completedBytes=excluded.completedBytes,totalBytes=excluded.totalBytes,
       attempts=case when excluded.state='failed' then sync_v2_transfers.attempts+1 else sync_v2_transfers.attempts end,
       lastError=excluded.lastError, updatedAt=excluded.updatedAt`,
    [input.scopeId, input.transferId, input.objectId, input.blobId ?? null,
      input.direction, input.state, String(input.completedBytes ?? 0), String(input.totalBytes ?? 0),
      input.error?.slice(0, 2_000) ?? null, Date.now()],
  )
}

export async function completeSyncV2TransfersForObject(
  scopeId: string,
  objectId: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_transfers set state = 'complete', lastError = null, updatedAt = $3
     where scopeId = $1 and objectId = $2 and state in ('pending','running','failed')`,
    [scopeId, objectId, Date.now()],
  )
}

export async function expireStaleSyncV2AssetBindings(
  scopeId: string,
  updatedBefore: number,
): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `update sync_v2_transfers set state = 'failed', attempts = attempts + 1,
       lastError = '附件引用等待上传超时；请重试同步，或删除正文中的失效附件引用', updatedAt = $3
     where scopeId = $1 and transferId like 'asset-binding:%'
       and state in ('pending','running') and updatedAt < $2`,
    [scopeId, updatedBefore, Date.now()],
  )
  return result.rowsAffected
}

export async function getSyncV2Transfer(scopeId: string, transferId: string): Promise<{
  state: 'pending' | 'running' | 'complete' | 'failed'
  attempts: number
  lastError: string | null
} | null> {
  const db = await getDb()
  const rows = await db.select<Array<{
    state: 'pending' | 'running' | 'complete' | 'failed'
    attempts: number
    lastError: string | null
  }>>(
    `select state, attempts, lastError from sync_v2_transfers
     where scopeId = $1 and transferId = $2 limit 1`,
    [scopeId, transferId],
  )
  return rows[0] ?? null
}

export async function retrySyncV2Problems(scopeId: string): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  const blocked = await db.select<SyncV2OutboxEntry[]>(
    `select * from sync_v2_outbox where scopeId = $1 and blocked = 1 order by createdAt, id`,
    [scopeId],
  )
  const operations: SyncV2AtomicStatement[] = []
  for (const entry of blocked) {
    if (entry.lastError === 'command_id_reused'
      || entry.lastError === 'revision_conflict'
      || entry.lastError === 'conflict_changed') {
      operations.push({
        statement: 'delete from sync_v2_outbox where scopeId = $1 and commandId = $2',
        values: [scopeId, entry.commandId],
      })
      continue
    }
    const hasConflict = entry.objectId
      ? (await db.select<Array<{ present: number }>>(
          `select 1 as present from sync_v2_conflicts
           where scopeId = $1 and objectId = $2 and status = 'unresolved' limit 1`,
          [scopeId, entry.objectId],
        )).length > 0
      : false
    if (hasConflict) {
      operations.push({
        statement: 'delete from sync_v2_outbox where scopeId = $1 and commandId = $2',
        values: [scopeId, entry.commandId],
      })
      continue
    }
    // A create-conflict command is conditional on the object's old revision.
    // Once that revision changed, replay can never succeed. The durable local
    // conflict record remains available for the user to recompute/resolve.
    if (entry.lastError === 'conflict_changed' && entry.commandType === 'create-conflict') {
      operations.push({
        statement: 'delete from sync_v2_outbox where scopeId = $1 and commandId = $2 and blocked = 1',
        values: [scopeId, entry.commandId],
      })
      continue
    }
    operations.push({
      statement: `update sync_v2_outbox set blocked = 0, attempts = 0,
        lastError = null, updatedAt = $3 where scopeId = $1 and commandId = $2 and blocked = 1`,
      values: [scopeId, entry.commandId, now],
    })
  }
  operations.push({
    statement: `update sync_v2_inbox set status = 'pending', lastError = null
      where scopeId = $1 and status = 'failed'`,
    values: [scopeId],
  }, {
    statement: `update sync_v2_transfers set state = 'pending', attempts = 0,
      lastError = null, updatedAt = $2 where scopeId = $1 and state = 'failed'`,
    values: [scopeId, now],
  })
  await applySyncV2AtomicBatch(operations)
}

export async function listRecentActiveSyncV2TransferBlobIds(
  scopeId: string,
  updatedAfter: number,
): Promise<string[]> {
  const db = await getDb()
  const rows = await db.select<Array<{ blobId: string }>>(
    `select distinct blobId from sync_v2_transfers
     where scopeId = $1 and blobId is not null
       and state in ('pending','running','failed') and updatedAt >= $2`,
    [scopeId, updatedAfter],
  )
  return rows.map(row => row.blobId)
}

export async function replaceSyncV2ResourceRefs(input: {
  scopeId: string
  ownerObjectId: string
  resources: Array<{ resourceObjectId: string, localPath: string }>
}): Promise<void> {
  const now = Date.now()
  const operations: SyncV2AtomicStatement[] = [{
    statement: 'delete from sync_v2_resource_refs where scopeId = $1 and ownerObjectId = $2',
    values: [input.scopeId, input.ownerObjectId],
  }]
  for (const resource of input.resources) {
    operations.push({
      statement: `insert into sync_v2_resource_refs
        (scopeId,ownerObjectId,resourceObjectId,localPath,updatedAt)
        values($1,$2,$3,$4,$5)`,
      values: [input.scopeId, input.ownerObjectId, resource.resourceObjectId,
        resource.localPath, now],
    })
  }
  await applySyncV2AtomicBatch(operations)
}

export async function recordSyncV2Mutation(input: {
  scopeId: string
  mutationId: string
  objectId: string | null
  kind: string
  payload: unknown
}): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `insert into sync_v2_mutation_journal(scopeId, mutationId, objectId, kind, payloadJson,
       state, lastError, createdAt, updatedAt)
     values($1,$2,$3,$4,$5,'materialized',null,$6,$6)
     on conflict(scopeId, mutationId) do nothing`,
    [input.scopeId, input.mutationId, input.objectId, input.kind, JSON.stringify(input.payload), now],
  )
}

export async function markSyncV2MutationQueued(scopeId: string, mutationId: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update sync_v2_mutation_journal set state='queued', updatedAt=$3
     where scopeId=$1 and mutationId=$2`, [scopeId, mutationId, Date.now()],
  )
}

export async function completeSyncV2Mutation(scopeId: string, mutationId: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    'delete from sync_v2_mutation_journal where scopeId=$1 and mutationId=$2',
    [scopeId, mutationId],
  )
}

/**
 * A queued mutation must be referenced by either the staging outbox or a v2
 * command. If neither reference exists, its replacing command was already
 * acknowledged (or a newer mutation for the same object superseded it).
 */
export async function retireSettledSyncV2Mutations(scopeId: string): Promise<number> {
  return await applySyncV2AtomicBatch([{
    statement: `delete from sync_v2_mutation_journal as mutation
      where mutation.scopeId = $1 and mutation.state = 'queued'
        and not exists (
          select 1 from note_gen_server_sync_outbox staging
          where staging.workspaceId = mutation.scopeId
            and staging.operationId = mutation.mutationId
        )
        and not exists (
          select 1 from sync_v2_outbox command
          where command.scopeId = mutation.scopeId
            and (command.commandId = mutation.mutationId
              or instr(command.commandJson, '"' || mutation.mutationId || '"') > 0)
        )`,
    values: [scopeId],
  }])
}
