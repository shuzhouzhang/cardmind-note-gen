import { getDb } from './index'
import { applySyncAtomicBatch } from './note-gen-server-sync-index'

export type NoteGenServerOutboxAction = 'upsert' | 'delete'

export interface NoteGenServerSyncObject {
  workspaceId: string
  objectId: string
  kind: string
  relativePath: string
  revision: string
  contentHash: string | null
}

export interface NoteGenServerOutboxEntry {
  id: number
  workspaceId: string
  operationId: string
  objectId: string
  kind: string
  relativePath: string
  action: NoteGenServerOutboxAction
  baseRevision: string | null
  payloadJson: string | null
  contentHash: string | null
  attempts: number
  lastError: string | null
  blocked: number
  createdAt: number
  updatedAt: number
}

export interface NoteGenServerInboxEntry {
  id: number
  workspaceId: string
  objectId: string
  revision: string
  sequence: string | null
  kind: string
  ciphertext: string
  ciphertextHash: string
  keyVersion: number
  blobRefsJson: string
  deleted: number
  status: 'pending' | 'applied' | 'failed'
  attempts: number
  lastError: string | null
  receivedAt: number
  appliedAt: number | null
}

export interface NoteGenServerSyncQueueStats {
  pendingOutbox: number
  blockedOutbox: number
  storedInbox: number
  failedInbox: number
}

export async function initNoteGenServerQueueDb() {
  const db = await getDb()
  await db.execute(`
    create table if not exists note_gen_server_sync_state (
      workspaceId text primary key,
      cursor text not null default '0',
      lastSuccessfulSyncAt integer default null,
      updatedAt integer not null
    )
  `)
  await db.execute(`
    create table if not exists note_gen_server_sync_objects (
      workspaceId text not null,
      objectId text not null,
      kind text not null default 'note',
      relativePath text not null,
      revision text not null,
      contentHash text default null,
      updatedAt integer not null,
      primary key (workspaceId, objectId),
      unique (workspaceId, relativePath)
    )
  `)
  await db.execute(`
    create table if not exists note_gen_server_sync_outbox (
      id integer primary key autoincrement,
      workspaceId text not null,
      operationId text not null,
      objectId text not null,
      kind text not null default 'note',
      relativePath text not null,
      action text not null check (action in ('upsert', 'delete')),
      baseRevision text default null,
      payloadJson text default null,
      contentHash text default null,
      attempts integer not null default 0,
      lastError text default null,
      blocked integer not null default 0,
      createdAt integer not null,
      updatedAt integer not null,
      unique (workspaceId, objectId),
      unique (workspaceId, operationId)
    )
  `)
  try {
    await db.execute("alter table note_gen_server_sync_objects add column kind text not null default 'note'")
  } catch {
    // Idempotent migration.
  }
  try {
    await db.execute("alter table note_gen_server_sync_outbox add column kind text not null default 'note'")
  } catch {
    // Idempotent migration.
  }
  try {
    await db.execute('alter table note_gen_server_sync_outbox add column blocked integer not null default 0')
  } catch {
    // Idempotent migration.
  }
  await db.execute(`
    create index if not exists idx_note_gen_server_outbox_workspace_created
    on note_gen_server_sync_outbox(workspaceId, createdAt)
  `)
  await db.execute(`
    create table if not exists note_gen_server_sync_inbox (
      id integer primary key autoincrement,
      workspaceId text not null,
      objectId text not null,
      revision text not null,
      sequence text default null,
      kind text not null,
      ciphertext text not null,
      ciphertextHash text not null,
      keyVersion integer not null,
      blobRefsJson text not null default '[]',
      deleted integer not null default 0,
      status text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
      attempts integer not null default 0,
      lastError text default null,
      receivedAt integer not null,
      appliedAt integer default null,
      unique (workspaceId, objectId, revision)
    )
  `)
  await db.execute(`
    create index if not exists idx_note_gen_server_inbox_workspace_status_received
    on note_gen_server_sync_inbox(workspaceId, status, receivedAt)
  `)
}

export async function enqueueNoteGenServerInbox(input: {
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
  const db = await getDb()
  await db.execute(
    `insert into note_gen_server_sync_inbox (
       workspaceId, objectId, revision, sequence, kind, ciphertext, ciphertextHash,
       keyVersion, blobRefsJson, deleted, status, attempts, lastError, receivedAt, appliedAt
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 0, null, $11, null)
     on conflict(workspaceId, objectId, revision) do nothing`,
    [
      input.workspaceId,
      input.objectId,
      input.revision,
      input.sequence,
      input.kind,
      input.ciphertext,
      input.ciphertextHash,
      input.keyVersion,
      JSON.stringify(input.blobRefs),
      input.deleted ? 1 : 0,
      Date.now(),
    ],
  )
}

export async function listPendingNoteGenServerInbox(
  workspaceId: string,
  kind?: string,
): Promise<NoteGenServerInboxEntry[]> {
  const db = await getDb()
  const kindFilter = kind ? ' and kind = $2' : ''
  return await db.select<NoteGenServerInboxEntry[]>(
    `select id, workspaceId, objectId, revision, sequence, kind, ciphertext, ciphertextHash,
       keyVersion, blobRefsJson, deleted, status, attempts, lastError, receivedAt, appliedAt
     from note_gen_server_sync_inbox
     where workspaceId = $1 and status != 'applied'${kindFilter}
     order by receivedAt asc, id asc`,
    kind ? [workspaceId, kind] : [workspaceId],
  )
}

export async function completeNoteGenServerInboxEntry(
  workspaceId: string,
  objectId: string,
  revision: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update note_gen_server_sync_inbox
     set status = 'applied', lastError = null, appliedAt = $4
     where workspaceId = $1 and objectId = $2 and revision = $3`,
    [workspaceId, objectId, revision, Date.now()],
  )
}

export async function failNoteGenServerInboxEntry(
  workspaceId: string,
  objectId: string,
  revision: string,
  error: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update note_gen_server_sync_inbox
     set status = 'failed', attempts = attempts + 1, lastError = $4
     where workspaceId = $1 and objectId = $2 and revision = $3`,
    [workspaceId, objectId, revision, error.slice(0, 2_000)],
  )
}

export async function pruneAppliedNoteGenServerInbox(
  workspaceId: string,
  olderThan: number,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `delete from note_gen_server_sync_inbox
     where workspaceId = $1 and status = 'applied' and appliedAt < $2`,
    [workspaceId, olderThan],
  )
}

export async function getNoteGenServerSyncQueueStats(
  workspaceId: string,
): Promise<NoteGenServerSyncQueueStats> {
  const db = await getDb()
  const rows = await db.select<NoteGenServerSyncQueueStats[]>(
    `select
       (select count(*) from note_gen_server_sync_outbox where workspaceId = $1 and blocked = 0) as pendingOutbox,
       (select count(*) from note_gen_server_sync_outbox where workspaceId = $1 and blocked = 1) as blockedOutbox,
       (select count(*) from note_gen_server_sync_inbox where workspaceId = $1 and status != 'applied') as storedInbox,
       (select count(*) from note_gen_server_sync_inbox where workspaceId = $1 and status = 'failed') as failedInbox`,
    [workspaceId],
  )
  return rows[0] ?? { pendingOutbox: 0, blockedOutbox: 0, storedInbox: 0, failedInbox: 0 }
}

export async function getNoteGenServerCursor(workspaceId: string): Promise<string> {
  const db = await getDb()
  const rows = await db.select<Array<{ cursor: string }>>(
    'select cursor from note_gen_server_sync_state where workspaceId = $1 limit 1',
    [workspaceId],
  )
  return rows[0]?.cursor ?? '0'
}

export async function setNoteGenServerCursor(workspaceId: string, cursor: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into note_gen_server_sync_state (workspaceId, cursor, lastSuccessfulSyncAt, updatedAt)
     values ($1, $2, $3, $3)
     on conflict(workspaceId) do update set
       cursor = excluded.cursor,
       lastSuccessfulSyncAt = excluded.lastSuccessfulSyncAt,
       updatedAt = excluded.updatedAt`,
    [workspaceId, cursor, Date.now()],
  )
}

export async function getNoteGenServerSyncObject(
  workspaceId: string,
  objectId: string,
): Promise<NoteGenServerSyncObject | null> {
  const db = await getDb()
  const rows = await db.select<NoteGenServerSyncObject[]>(
    `select workspaceId, objectId, kind, relativePath, revision, contentHash
     from note_gen_server_sync_objects
     where workspaceId = $1 and objectId = $2
     limit 1`,
    [workspaceId, objectId],
  )
  return rows[0] ?? null
}

export async function listNoteGenServerSyncObjects(workspaceId: string): Promise<NoteGenServerSyncObject[]> {
  const db = await getDb()
  return await db.select<NoteGenServerSyncObject[]>(
    `select workspaceId, objectId, kind, relativePath, revision, contentHash
     from note_gen_server_sync_objects where workspaceId = $1`,
    [workspaceId],
  )
}

export async function upsertNoteGenServerSyncObject(object: NoteGenServerSyncObject): Promise<void> {
  const now = Date.now()
  const collisionWhere = `workspaceId=$1 and relativePath=$2 and objectId!=$3`
  await applySyncAtomicBatch([
    {
      statement: `delete from sync_outbox where scopeId=$1 and objectId in (
        select objectId from note_gen_server_sync_objects where ${collisionWhere})`,
      values: [object.workspaceId, object.relativePath, object.objectId],
    },
    {
      statement: `delete from sync_mutation_journal where scopeId=$1 and objectId in (
        select objectId from note_gen_server_sync_objects where ${collisionWhere})`,
      values: [object.workspaceId, object.relativePath, object.objectId],
    },
    {
      statement: `update sync_entities set localKey='__sync_replaced__/' || objectId,
        deleted=1, updatedAt=$4 where scopeId=$1 and objectId in (
          select objectId from note_gen_server_sync_objects where ${collisionWhere})`,
      values: [object.workspaceId, object.relativePath, object.objectId, now],
    },
    {
      statement: `delete from note_gen_server_sync_outbox where workspaceId=$1 and objectId in (
        select objectId from note_gen_server_sync_objects where ${collisionWhere})`,
      values: [object.workspaceId, object.relativePath, object.objectId],
    },
    {
      statement: `delete from note_gen_server_sync_objects where ${collisionWhere}`,
      values: [object.workspaceId, object.relativePath, object.objectId],
    },
    {
      statement: `insert into note_gen_server_sync_objects (
         workspaceId, objectId, kind, relativePath, revision, contentHash, updatedAt
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict(workspaceId, objectId) do update set
         kind = excluded.kind,
         relativePath = excluded.relativePath,
         revision = excluded.revision,
         contentHash = excluded.contentHash,
         updatedAt = excluded.updatedAt`,
      values: [object.workspaceId, object.objectId, object.kind, object.relativePath,
        object.revision, object.contentHash, now],
    },
  ])
}

export async function deleteNoteGenServerSyncObject(
  workspaceId: string,
  objectId: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    'delete from note_gen_server_sync_objects where workspaceId = $1 and objectId = $2',
    [workspaceId, objectId],
  )
}

export async function enqueueNoteGenServerOutbox(input: {
  workspaceId: string
  operationId: string
  objectId: string
  kind: string
  relativePath: string
  action: NoteGenServerOutboxAction
  baseRevision: string | null
  payloadJson: string | null
  contentHash: string | null
}): Promise<void> {
  const now = Date.now()
  await applySyncAtomicBatch([{
    statement: `delete from sync_mutation_journal
      where scopeId = $1 and mutationId != $3 and mutationId = (
        select operationId from note_gen_server_sync_outbox
        where workspaceId = $1 and objectId = $2 limit 1
      )`,
    values: [input.workspaceId, input.objectId, input.operationId],
  }, {
    statement: `insert into note_gen_server_sync_outbox (
      workspaceId, operationId, objectId, kind, relativePath, action, baseRevision,
      payloadJson, contentHash, attempts, lastError, blocked, createdAt, updatedAt
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, null, 0, $10, $10)
    on conflict(workspaceId, objectId) do update set
      operationId = excluded.operationId,
      kind = excluded.kind,
      relativePath = excluded.relativePath,
      action = excluded.action,
      baseRevision = note_gen_server_sync_outbox.baseRevision,
      payloadJson = excluded.payloadJson,
      contentHash = excluded.contentHash,
      attempts = 0,
      lastError = null,
      blocked = 0,
      updatedAt = excluded.updatedAt`,
    values: [
      input.workspaceId,
      input.operationId,
      input.objectId,
      input.kind,
      input.relativePath,
      input.action,
      input.baseRevision,
      input.payloadJson,
      input.contentHash,
      now,
    ],
  }])
}

export async function listNoteGenServerOutbox(
  workspaceId: string,
  limit = 100,
): Promise<NoteGenServerOutboxEntry[]> {
  const db = await getDb()
  return await db.select<NoteGenServerOutboxEntry[]>(
    `select id, workspaceId, operationId, objectId, kind, relativePath, action, baseRevision,
       payloadJson, contentHash, attempts, lastError, blocked, createdAt, updatedAt
     from note_gen_server_sync_outbox
     where workspaceId = $1 and blocked = 0
     order by createdAt asc, id asc
     limit $2`,
    [workspaceId, limit],
  )
}

export async function hasPendingNoteGenServerOperation(
  workspaceId: string,
  objectId: string,
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select<Array<{ present: number }>>(
    `select 1 as present from note_gen_server_sync_outbox
     where workspaceId = $1 and objectId = $2 and blocked = 0 limit 1`,
    [workspaceId, objectId],
  )
  return rows.length > 0
}

export async function getNoteGenServerOutboxForObject(
  workspaceId: string,
  objectId: string,
): Promise<NoteGenServerOutboxEntry | null> {
  const db = await getDb()
  const rows = await db.select<NoteGenServerOutboxEntry[]>(
    `select id, workspaceId, operationId, objectId, kind, relativePath, action, baseRevision,
       payloadJson, contentHash, attempts, lastError, blocked, createdAt, updatedAt
     from note_gen_server_sync_outbox
     where workspaceId = $1 and objectId = $2 limit 1`,
    [workspaceId, objectId],
  )
  return rows[0] ?? null
}

export async function deleteNoteGenServerOutboxEntry(entryId: number, operationId: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    'delete from note_gen_server_sync_outbox where id = $1 and operationId = $2',
    [entryId, operationId],
  )
}

export async function completeNoteGenServerOutboxEntry(input: {
  entryId: number
  operationId: string
  workspaceId: string
  objectId: string
  relativePath: string
  kind: string
  action: NoteGenServerOutboxAction
  revision: string
  contentHash: string | null
}): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update note_gen_server_sync_outbox
     set baseRevision = $3, updatedAt = $4
     where id = $1 and operationId != $2`,
    [input.entryId, input.operationId, input.revision, Date.now()],
  )
  if (input.action === 'delete') {
    await deleteNoteGenServerSyncObject(input.workspaceId, input.objectId)
  } else {
    await upsertNoteGenServerSyncObject({
      workspaceId: input.workspaceId,
      objectId: input.objectId,
      kind: input.kind,
      relativePath: input.relativePath,
      revision: input.revision,
      contentHash: input.contentHash,
    })
  }
  await db.execute(
    'delete from note_gen_server_sync_outbox where id = $1 and operationId = $2',
    [input.entryId, input.operationId],
  )
}

export async function settleConflictedNoteGenServerOutboxEntry(input: {
  entryId: number
  operationId: string
  remoteRevision: string
}): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update note_gen_server_sync_outbox
     set baseRevision = $3, updatedAt = $4
     where id = $1 and operationId != $2`,
    [input.entryId, input.operationId, input.remoteRevision, Date.now()],
  )
  await db.execute(
    'delete from note_gen_server_sync_outbox where id = $1 and operationId = $2',
    [input.entryId, input.operationId],
  )
}

export async function rebaseConflictedNoteGenServerOutboxEntry(input: {
  entryId: number
  operationId: string
  remoteRevision: string
}): Promise<void> {
  const db = await getDb()
  await db.execute(
    `update note_gen_server_sync_outbox
     set operationId = $3, baseRevision = $4, attempts = 0, lastError = null, updatedAt = $5
     where id = $1 and operationId = $2`,
    [input.entryId, input.operationId, crypto.randomUUID(), input.remoteRevision, Date.now()],
  )
}

export async function reconcileNoteGenServerSyncedObject(input: {
  workspaceId: string
  objectId: string
  kind: string
  relativePath: string
  revision: string
  contentHash: string
}): Promise<void> {
  await upsertNoteGenServerSyncObject(input)
  const db = await getDb()
  await db.execute(
    `delete from note_gen_server_sync_outbox
     where workspaceId = $1 and objectId = $2 and contentHash = $3 and action = 'upsert'`,
    [input.workspaceId, input.objectId, input.contentHash],
  )
}

export async function failNoteGenServerOutboxEntry(
  entryId: number,
  operationId: string,
  error: string,
): Promise<boolean> {
  const db = await getDb()
  const result = await db.execute(
    `update note_gen_server_sync_outbox
     set attempts = attempts + 1, lastError = $3, updatedAt = $4
     where id = $1 and operationId = $2`,
    [entryId, operationId, error.slice(0, 2_000), Date.now()],
  )
  return result.rowsAffected > 0
}

export async function blockNoteGenServerOutboxEntry(
  entryId: number,
  operationId: string,
  error: string,
): Promise<boolean> {
  const db = await getDb()
  const result = await db.execute(
    `update note_gen_server_sync_outbox
     set blocked = 1, attempts = attempts + 1, lastError = $3, updatedAt = $4
     where id = $1 and operationId = $2`,
    [entryId, operationId, error.slice(0, 2_000), Date.now()],
  )
  return result.rowsAffected > 0
}

export async function retryBlockedNoteGenServerOutbox(workspaceId: string): Promise<void> {
  const db = await getDb()
  await retireStaleBlockedNoteGenServerOutbox(workspaceId)
  await db.execute(
    `update note_gen_server_sync_outbox
     set blocked = 0, attempts = 0, lastError = null, updatedAt = $2
     where workspaceId = $1 and blocked = 1`,
    [workspaceId, Date.now()],
  )
}

export async function retireStaleBlockedNoteGenServerOutbox(workspaceId: string): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `delete from note_gen_server_sync_outbox
     where workspaceId = $1 and blocked = 1
       and (lastError like '%command_id_reused%'
         or lastError like '%revision_conflict%'
         or lastError like '%conflict_changed%')`,
    [workspaceId],
  )
  return result.rowsAffected
}
