import { getDb } from "./index"
import { Store } from '@tauri-apps/plugin-store';
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-bridge'

const AUTO_IDEA_TAG_SYNC_ID = '9e4d5c6b-6a27-4f5d-9c65-1f347f7e5d91'

export interface Tag {
  id: number
  name: string
  isLocked?: boolean
  isPin?: boolean
  sortOrder?: number
  total?: number
  syncId?: string | null
}

function enqueueRecordsAutoSync(reason: string) {
  enqueueAutoDataSync('records', reason)
}

// 创建 tags 表
export async function initTagsDb() {
  const db = await getDb()
  await db.execute(`
    create table if not exists tags (
      id integer primary key autoincrement,
      name text not null,
      isLocked boolean DEFAULT false,
      isPin boolean DEFAULT false,
      sortOrder integer DEFAULT 0
    )
  `)
  try {
    await db.execute('alter table tags add column syncId text default null')
  } catch {
    // Idempotent migration.
  }
  await db.execute('create unique index if not exists idx_tags_sync_id on tags(syncId) where syncId is not null')
  await db.execute(`
    create table if not exists tag_sync_aliases (
      syncId text primary key,
      tagId integer not null
    )
  `)
  await db.execute(
    'insert or ignore into tag_sync_aliases(syncId, tagId) select syncId, id from tags where syncId is not null',
  )
  const lockedTags = await db.select<Tag[]>(
    'select * from tags where isLocked = true order by name, id',
  )
  const lockedTagGroups = new Map<string, Tag[]>()
  for (const tag of lockedTags) {
    lockedTagGroups.set(tag.name, [...(lockedTagGroups.get(tag.name) ?? []), tag])
  }
  for (const duplicates of lockedTagGroups.values()) {
    const canonical = duplicates[0]
    if (!canonical || duplicates.length < 2) continue
    for (const duplicate of duplicates.slice(1)) {
      await db.execute('update marks set tagId = $1 where tagId = $2', [canonical.id, duplicate.id])
      if (duplicate.syncId) await registerTagSyncAlias(duplicate.syncId, canonical.id)
      await db.execute('delete from tags where id = $1', [duplicate.id])
    }
  }
  
  // 检查 sortOrder 列是否存在，如果不存在则添加
  try {
    await db.execute("select sortOrder from tags limit 1")
  } catch {
    // sortOrder 列不存在，添加该列
    await db.execute("alter table tags add column sortOrder integer DEFAULT 0")
    
    // 为现有标签设置初始排序值
    const existingTags = await db.select<Tag[]>("select id from tags order by id asc")
    for (let i = 0; i < existingTags.length; i++) {
      await db.execute("update tags set sortOrder = $1 where id = $2", [i, existingTags[i].id])
    }
  }
  
}

/**
 * Returns a usable tag for a new record. A fresh installation intentionally
 * starts without tags; the built-in Idea tag is created only when the user
 * actually saves their first record. Its stable identity is shared by every
 * device in a workspace so concurrent first records do not create duplicate
 * Idea tags after synchronization.
 */
export async function ensureRecordTag(preferredTagId?: number | null): Promise<Tag> {
  await initTagsDb()
  const db = await getDb()
  if (preferredTagId) {
    const preferred = (await db.select<Tag[]>('select * from tags where id = $1 limit 1', [preferredTagId]))[0]
    if (preferred) return preferred
  }

  const existing = (await db.select<Tag[]>('select * from tags order by sortOrder asc, id asc limit 1'))[0]
  if (existing) return existing

  await db.execute(
    `insert into tags (name, isLocked, isPin, sortOrder, syncId)
     values ($1, true, true, 0, $2)
     on conflict do nothing`,
    ['Idea', AUTO_IDEA_TAG_SYNC_ID],
  )
  const idea = (await db.select<Tag[]>('select * from tags where syncId = $1 limit 1', [AUTO_IDEA_TAG_SYNC_ID]))[0]
  if (!idea) throw new Error('无法创建记录所需的 Idea 标签')
  await registerTagSyncAlias(AUTO_IDEA_TAG_SYNC_ID, idea.id)

  const store = await Store.load('store.json')
  await store.set('currentTagId', idea.id)
  await store.save()
  enqueueRecordsAutoSync('tag:auto-create-idea')
  return idea
}

export async function getTags() {
  const db = await getDb();
  const tags = await db.select<Tag[]>("select * from tags order by sortOrder asc, id asc")

  for (const tag of tags) {
    if (tag.syncId) continue
    tag.syncId = crypto.randomUUID()
    await db.execute('update tags set syncId = $1 where id = $2 and syncId is null', [tag.syncId, tag.id])
    await registerTagSyncAlias(tag.syncId, tag.id)
  }

  // 获取 tags 对应的 marks 数量
  for (const tag of tags) {
    // deleted = 0  
    const res = await db.select<{ total: number }[]>("select count(*) as total from marks where tagId = $1 and deleted = $2", [tag.id, 0])
    tag.total = res[0].total
  }

  return tags
}

/**
 * Repairs records left behind by legacy tag deletion/import code. Older builds
 * could delete a tag row before converting its records from a numeric tagId to
 * the stable syncId. Prefer the historical tag's current semantic equivalent;
 * if none survives, keep the records visible under an explicit recovery tag.
 */
export async function repairOrphanedMarkTags(syncScopeId: string): Promise<boolean> {
  const db = await getDb()
  const orphanGroups = await db.select<Array<{ tagId: number }>>(
    `select distinct marks.tagId as tagId from marks
     left join tags on tags.id = marks.tagId
     where tags.id is null`,
  )
  if (orphanGroups.length === 0) return false

  const currentTags = await db.select<Tag[]>('select * from tags order by sortOrder asc, id asc')
  const history = await db.select<Array<{ basePayloadJson: string | null }>>(
    `select basePayloadJson from sync_entities
     where scopeId = $1 and kind = 'tag' and basePayloadJson is not null`,
    [syncScopeId],
  )
  for (const orphan of orphanGroups) {
    let historical: { name?: string, syncId?: string, legacyId?: number } | null = null
    for (const row of history) {
      try {
        const value = JSON.parse(row.basePayloadJson ?? 'null')?.value
        if (value?.legacyId === orphan.tagId) {
          historical = value
          break
        }
      } catch {
        // A corrupt historical snapshot must not prevent preserving local records.
      }
    }
    let target = currentTags.find(tag => tag.syncId === historical?.syncId)
      ?? currentTags.find(tag => historical?.name && tag.name === historical.name)
    if (!target) {
      const syncId = crypto.randomUUID()
      const name = historical?.name ? `${historical.name}（已恢复）` : `Recovered ${orphan.tagId}`
      const result = await db.execute(
        `insert into tags(name, isLocked, isPin, sortOrder, syncId)
         values($1, false, false, (select coalesce(max(sortOrder), -1) + 1 from tags), $2)`,
        [name, syncId],
      )
      target = { id: Number(result.lastInsertId), name, syncId }
      currentTags.push(target)
    }
    await db.execute('update marks set tagId = $1 where tagId = $2', [target.id, orphan.tagId])
  }
  return true
}

export async function upsertTagFromNoteGenServerSync(
  tag: Omit<Tag, 'id'> & { id?: number, syncId: string },
): Promise<Tag> {
  const db = await getDb()
  let existing = (await db.select<Tag[]>('select * from tags where syncId = $1 limit 1', [tag.syncId]))[0]
  if (!existing && tag.id !== undefined) {
    existing = (await db.select<Tag[]>(
      'select * from tags where id = $1 and name = $2 limit 1',
      [tag.id, tag.name],
    ))[0]
  }
  if (!existing && tag.isLocked) {
    existing = (await db.select<Tag[]>(
      'select * from tags where name = $1 and isLocked = true limit 1',
      [tag.name],
    ))[0]
  }
  if (existing) {
    const canonicalSyncId = existing.syncId ?? tag.syncId
    await db.execute(
      'update tags set name = $1, isLocked = $2, isPin = $3, sortOrder = $4, syncId = $5 where id = $6',
      [tag.name, tag.isLocked, tag.isPin, tag.sortOrder, canonicalSyncId, existing.id],
    )
    await registerTagSyncAlias(tag.syncId, existing.id)
    await registerTagSyncAlias(canonicalSyncId, existing.id)
    return { ...tag, id: existing.id, syncId: canonicalSyncId }
  }
  const result = await db.execute(
    'insert into tags (name, isLocked, isPin, sortOrder, syncId) values ($1, $2, $3, $4, $5)',
    [tag.name, tag.isLocked, tag.isPin, tag.sortOrder, tag.syncId],
  )
  const id = Number(result.lastInsertId)
  await registerTagSyncAlias(tag.syncId, id)
  return { ...tag, id }
}

export async function getTagBySyncId(syncId: string): Promise<Tag | null> {
  const db = await getDb()
  return (await db.select<Tag[]>(
    `select tags.* from tags
     left join tag_sync_aliases aliases on aliases.tagId = tags.id
     where tags.syncId = $1 or aliases.syncId = $1
     limit 1`,
    [syncId],
  ))[0] ?? null
}

/**
 * Repairs an old remote record whose tag object never reached the server.
 * Prefer the built-in Idea tag when that is clearly the missing semantic
 * target; otherwise keep the record visible under an explicit recovery tag.
 */
export async function recoverMissingTagReference(syncId: string): Promise<boolean> {
  await initTagsDb()
  if (await getTagBySyncId(syncId)) return false

  const db = await getDb()
  let target = (await db.select<Tag[]>(
    "select * from tags where name = 'Idea' and isLocked = true order by id limit 1",
  ))[0]
  if (!target) {
    const count = (await db.select<Array<{ total: number }>>('select count(*) as total from tags'))[0]?.total ?? 0
    if (Number(count) === 0) {
      target = await ensureRecordTag(null)
    } else {
      const result = await db.execute(
        `insert into tags(name,isLocked,isPin,sortOrder,syncId)
         values($1,false,false,(select coalesce(max(sortOrder),-1)+1 from tags),$2)
         on conflict do nothing`,
        [`Recovered ${syncId.slice(0, 8)}`, syncId],
      )
      target = (await db.select<Tag[]>('select * from tags where syncId = $1 limit 1', [syncId]))[0]
        ?? (result.lastInsertId
          ? (await db.select<Tag[]>('select * from tags where id = $1 limit 1', [result.lastInsertId]))[0]
          : undefined)
    }
  }
  if (!target) throw new Error(`无法恢复记录引用的标签：${syncId}`)

  await registerTagSyncAlias(syncId, target.id)
  enqueueRecordsAutoSync('tag:recover-missing-reference')
  return true
}

export async function deleteTagBySyncId(syncId: string): Promise<void> {
  const db = await getDb()
  await db.execute('delete from tags where syncId = $1 and isLocked = false', [syncId])
  await db.execute('delete from tag_sync_aliases where syncId = $1', [syncId])
  enqueueRecordsAutoSync('tag:sync-delete')
}

async function registerTagSyncAlias(syncId: string, tagId: number): Promise<void> {
  const db = await getDb()
  await db.execute(
    `insert into tag_sync_aliases(syncId, tagId) values($1, $2)
     on conflict(syncId) do update set tagId = excluded.tagId`,
    [syncId, tagId],
  )
}

export async function insertTag(tag: Partial<Tag>) {
  const db = await getDb();
  const result = await db.execute(
    "insert into tags (name) values ($1)",
    [tag.name]
  )
  enqueueRecordsAutoSync('tag:insert')
  return result
}

export async function updateTag(tag: Tag) {
  const db = await getDb();
  const result = await db.execute(
    "update tags set name = $1, isLocked = $2, isPin = $3, sortOrder = $4 where id = $5",
    [tag.name, tag.isLocked, tag.isPin, tag.sortOrder, tag.id]
  )
  enqueueRecordsAutoSync('tag:update')
  void import('@/lib/knowledge-index').then(({ enqueueKnowledgeSourceIndex }) => {
    void getDb().then(async database => {
      const marks = await database.select<Array<{ id: number }>>('select id from marks where tagId = $1 and deleted = 0', [tag.id])
      for (const mark of marks) {
        await database.execute(
          "update knowledge_sources set status = 'pending', indexed_hash = null, error = null where source_key = $1",
          [`record:${mark.id}`]
        )
      }
      marks.forEach(mark => enqueueKnowledgeSourceIndex(`record:${mark.id}`))
    })
  })
  return result
}

export async function delTag(id: number) {
  const db = await getDb();
  const result = await db.execute("delete from tags where id = $1", [id])
  await db.execute('delete from tag_sync_aliases where tagId = $1', [id])
  enqueueRecordsAutoSync('tag:delete')
  return result
}

export async function deleteAllTags() {
  const db = await getDb();
  const result = await db.execute("delete from tags where isLocked = false")
  await db.execute('delete from tag_sync_aliases where tagId not in (select id from tags)')
  enqueueRecordsAutoSync('tag:delete-all')
  return result
}

export async function insertTags(tags: Tag[]) {
  const db = await getDb();
  for (const tag of tags) {
    if (tag.isLocked) continue;
    const exists = await db.select<Tag[]>("select * from tags where id = $1", [tag.id])
    if (exists.length > 0) {
      await db.execute(
        "update tags set name = $1, isLocked = $2, isPin = $3, sortOrder = $4 where id = $5",
        [tag.name, tag.isLocked, tag.isPin, tag.sortOrder, tag.id]
      )
    } else {
      await db.execute(
        "insert into tags (id, name, isLocked, isPin, sortOrder) values ($1, $2, $3, $4, $5)",
        [tag.id, tag.name, tag.isLocked, tag.isPin, tag.sortOrder]
      )
    }
  }
  enqueueRecordsAutoSync('tag:bulk-insert')
  return true;
}

export async function updateTagsOrder(tags: { id: number; sortOrder: number }[]) {
  const db = await getDb();
  for (const tag of tags) {
    await db.execute(
      "update tags set sortOrder = $1 where id = $2",
      [tag.sortOrder, tag.id]
    )
  }
  enqueueRecordsAutoSync('tag:reorder')
  return true;
}
