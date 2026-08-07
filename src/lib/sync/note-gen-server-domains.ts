'use client'

import { Store } from '@tauri-apps/plugin-store'

import { filterSyncData, shouldExcludeFromSync } from '@/config/sync-exclusions'
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

export type NoteGenServerDataDomain = 'records' | 'settings' | 'conversations'
type NoteGenServerDataKind = 'tag' | 'mark' | 'canvas' | 'setting' | 'conversation'

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
interface DeletePayload {
  schemaVersion: 1
  type: 'delete'
  kind: NoteGenServerDataKind
  logicalKey: string
  deletedAt: number
}
type AppDataPayload = TagPayload | MarkPayload | CanvasPayload | SettingPayload | LegacySettingsPayload | ConversationPayload | DeletePayload

interface LocalObject {
  kind: NoteGenServerDataKind
  logicalKey: string
  payload: AppDataPayload
}

const DOMAIN_KINDS: Record<NoteGenServerDataDomain, NoteGenServerDataKind[]> = {
  records: ['tag', 'mark', 'canvas'],
  settings: ['setting'],
  conversations: ['conversation'],
}

const SUPPORTED_DATA_KINDS = new Set<NoteGenServerDataKind>(Object.values(DOMAIN_KINDS).flat())
const domainQueue = new Map<NoteGenServerDataDomain, Promise<boolean>>()

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
    collectLocalObjects(domain),
    listNoteGenServerSyncObjects(syncScopeId),
  ])
  const trackedById = new Map(trackedObjects.map(object => [object.objectId, object]))
  const localIds = new Set<string>()
  let queued = false

  for (const object of localObjects) {
    const objectId = await createDeterministicServerObjectId(profile.workspaceId, object.kind, object.logicalKey)
    localIds.add(objectId)
    queued = await queueObject({
      syncScopeId,
      objectId,
      object,
      tracked: trackedById.get(objectId) ?? null,
    }) || queued
  }

  for (const tracked of trackedObjects) {
    if (!DOMAIN_KINDS[domain].includes(tracked.kind as NoteGenServerDataKind) || localIds.has(tracked.objectId)) continue
    queued = await queueDeletedObject(syncScopeId, tracked) || queued
  }
  return queued
}

export async function queueCurrentNoteGenServerAppData(): Promise<number> {
  let queued = 0
  for (const domain of ['records', 'settings', 'conversations'] as const) {
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
}): Promise<void> {
  if (input.kind === 'setting' && isConnectionTestPayload(input.payload)) return
  if (!SUPPORTED_DATA_KINDS.has(input.kind as NoteGenServerDataKind)) return
  const { payload, logicalKey } = await resolveIncomingPayload(input)
  const expectedObjectId = await createDeterministicServerObjectId(input.workspaceId, input.kind, logicalKey)
  if (expectedObjectId !== input.objectId) throw new Error('服务器应用数据对象的身份与内容不匹配')
  setAutoDataSyncApplyingRemote(true)
  try {
    if (payload.type === 'delete') await applyDeletion(payload)
    else if (payload.type === 'tag') await applyTag(payload.value)
    else if (payload.type === 'mark') await applyMark(payload.value)
    else if (payload.type === 'canvas') await applyCanvas(payload.value)
    else if (payload.type === 'setting') await applySetting(payload.key, payload.value)
    else if (payload.type === 'settings') await applyLegacySettings(payload.value)
    else if (payload.type === 'conversation') await applyConversation(payload.value)
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

async function collectLocalObjects(domain: NoteGenServerDataDomain): Promise<LocalObject[]> {
  if (domain === 'records') {
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
            value: { ...value, syncId: tag.syncId as string, legacyId: tag.id },
          },
        }
      }),
      ...(await Promise.all(marks.map(async originalMark => {
        const { id, tagId, syncId, ...mark } = originalMark
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
              legacyId: id,
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
  const store = await Store.load('store.json')
  const entries = await store.entries()
  const settings = filterSyncData(Object.fromEntries(entries), {
    excludeSensitiveConfig: await store.get<boolean>('excludeSensitiveConfig') !== false,
  })
  return Object.entries(settings).map(([key, value]) => ({
    kind: 'setting',
    logicalKey: `setting:${key}`,
    payload: { schemaVersion: 1, type: 'setting', key, value },
  }))
}

async function queueObject(input: {
  syncScopeId: string
  objectId: string
  object: LocalObject
  tracked: NoteGenServerSyncObject | null
}): Promise<boolean> {
  const payloadJson = JSON.stringify(input.object.payload)
  const contentHash = await hashPayload(payloadJson)
  const pending = await getNoteGenServerOutboxForObject(input.syncScopeId, input.objectId)
  if (pending?.action === 'upsert' && pending.contentHash === contentHash) return false
  if (!pending && input.tracked?.contentHash === contentHash) return false
  await enqueueNoteGenServerOutbox({
    workspaceId: input.syncScopeId,
    operationId: crypto.randomUUID(),
    objectId: input.objectId,
    kind: input.object.kind,
    relativePath: input.object.logicalKey,
    action: 'upsert',
    baseRevision: input.tracked?.revision ?? null,
    payloadJson,
    contentHash,
  })
  return true
}

async function queueDeletedObject(syncScopeId: string, tracked: NoteGenServerSyncObject): Promise<boolean> {
  const pending = await getNoteGenServerOutboxForObject(syncScopeId, tracked.objectId)
  if (pending?.action === 'delete') return false
  const payload: DeletePayload = {
    schemaVersion: 1,
    type: 'delete',
    kind: tracked.kind as NoteGenServerDataKind,
    logicalKey: tracked.relativePath,
    deletedAt: Date.now(),
  }
  await enqueueNoteGenServerOutbox({
    workspaceId: syncScopeId,
    operationId: crypto.randomUUID(),
    objectId: tracked.objectId,
    kind: tracked.kind,
    relativePath: tracked.relativePath,
    action: 'delete',
    baseRevision: tracked.revision,
    payloadJson: JSON.stringify(payload),
    contentHash: null,
  })
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
    if (!tag) throw new Error(`记录引用的标签尚未同步：${syncedMark.tagSyncId}`)
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
  const nodes = await Promise.all(canvas.document.nodes.map(async node => {
    const data = { ...node.data }
    if (typeof data.recordSyncId === 'string') {
      const mark = await import('@/db/marks').then(module => module.getMarkBySyncId(data.recordSyncId as string))
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

async function applySetting(key: string, value: unknown): Promise<void> {
  const store = await Store.load('store.json')
  const excludeSensitiveConfig = await store.get<boolean>('excludeSensitiveConfig') !== false
  if (!shouldExcludeFromSync(key, { excludeSensitiveConfig })) await store.set(key, value)
  await store.save()
  await import('@/stores/setting').then(module => module.default.getState().initSettingData())
}

async function applyLegacySettings(settings: Record<string, unknown>): Promise<void> {
  const store = await Store.load('store.json')
  const excludeSensitiveConfig = await store.get<boolean>('excludeSensitiveConfig') !== false
  for (const [key, item] of Object.entries(settings)) {
    if (!shouldExcludeFromSync(key, { excludeSensitiveConfig })) await store.set(key, item)
  }
  await store.save()
  await import('@/stores/setting').then(module => module.default.getState().initSettingData())
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
    if (markId !== null) await import('@/db/marks').then(module => module.delMarkForever(markId))
    await import('@/stores/mark').then(async module => {
      await Promise.all([module.default.getState().fetchMarks(), module.default.getState().fetchAllMarks()])
    })
  } else if (payload.kind === 'canvas') {
    await import('@/db/canvases').then(module => module.permanentlyDeleteCanvasProject(id))
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
}

function logicalKeyForPayload(payload: Exclude<AppDataPayload, DeletePayload>): string {
  if (payload.type === 'setting') return `setting:${payload.key}`
  if (payload.type === 'settings') return 'settings'
  if (payload.type === 'conversation') return `conversation:${payload.value.syncId}`
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
