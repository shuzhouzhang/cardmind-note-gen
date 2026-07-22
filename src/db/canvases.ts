import { getDb } from './index'
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-queue'
import {
  DEFAULT_CANVAS_DOCUMENT,
  normalizeCanvasDocument,
  type CanvasDocument,
  type CanvasProject,
  type CanvasProjectRow,
  type CanvasProjectType,
} from '@/types/canvas'

function rowToProject(row: CanvasProjectRow): CanvasProject {
  let parsed: unknown = DEFAULT_CANVAS_DOCUMENT
  try {
    parsed = JSON.parse(row.content)
  } catch {
    parsed = DEFAULT_CANVAS_DOCUMENT
  }

  return {
    id: row.id,
    title: row.title,
    canvasType: row.canvasType,
    schemaVersion: row.schemaVersion,
    document: normalizeCanvasDocument(parsed),
    thumbnailPath: row.thumbnailPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pinnedAt: row.pinnedAt,
    deletedAt: row.deletedAt,
  }
}

function enqueueCanvasSync(reason: string) {
  enqueueAutoDataSync('records', reason)
}

export async function initCanvasesDb() {
  const db = await getDb()
  await db.execute(`
    create table if not exists canvases (
      id text primary key,
      title text not null,
      canvasType text not null,
      schemaVersion integer not null default 1,
      content text not null,
      thumbnailPath text default null,
      createdAt integer not null,
      updatedAt integer not null,
      pinnedAt integer default null,
      deletedAt integer default null
    )
  `)
  const canvasColumns = await db.select<Array<{ name: string }>>('pragma table_info(canvases)')
  if (!canvasColumns.some(column => column.name === 'pinnedAt')) {
    await db.execute('alter table canvases add column pinnedAt integer default null')
  }
  await db.execute(`
    create table if not exists canvas_versions (
      id integer primary key autoincrement,
      canvasId text not null,
      content text not null,
      createdAt integer not null
    )
  `)
  await db.execute('create index if not exists idx_canvas_versions_canvas on canvas_versions(canvasId, createdAt desc)')
}

export async function getCanvasProjects(options: { includeDeleted?: boolean } = {}) {
  const db = await getDb()
  const where = options.includeDeleted ? '' : 'where deletedAt is null'
  const rows = await db.select<CanvasProjectRow[]>(`
    select * from canvases ${where} order by updatedAt desc
  `)
  return rows.map(rowToProject)
}

export async function getCanvasProject(id: string) {
  const db = await getDb()
  const rows = await db.select<CanvasProjectRow[]>(
    'select * from canvases where id = $1 limit 1',
    [id]
  )
  return rows[0] ? rowToProject(rows[0]) : null
}

export async function insertCanvasProject(input: {
  id: string
  title: string
  canvasType: CanvasProjectType
  document?: CanvasDocument
  createdAt?: number
  updatedAt?: number
}) {
  const db = await getDb()
  const now = Date.now()
  const createdAt = input.createdAt ?? now
  const updatedAt = input.updatedAt ?? now
  await db.execute(
    `insert into canvases
      (id, title, canvasType, schemaVersion, content, createdAt, updatedAt)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.title,
      input.canvasType,
      1,
      JSON.stringify(input.document || DEFAULT_CANVAS_DOCUMENT),
      createdAt,
      updatedAt,
    ]
  )
  enqueueCanvasSync('canvas-created')
  return getCanvasProject(input.id)
}

export async function updateCanvasDocument(id: string, document: CanvasDocument) {
  const db = await getDb()
  const updatedAt = Date.now()
  const content = JSON.stringify(document)
  const existing = await db.select<Array<{ content: string }>>(
    'select content from canvases where id = $1 limit 1',
    [id]
  )
  if (existing[0]?.content && existing[0].content !== content) {
    const versionLimit = content.length >= 5_000_000 ? 10 : content.length >= 1_000_000 ? 20 : 50
    await db.execute(
      'insert into canvas_versions (canvasId, content, createdAt) values ($1, $2, $3)',
      [id, existing[0].content, updatedAt]
    )
    await db.execute(`
      delete from canvas_versions where canvasId = $1 and id not in (
        select id from canvas_versions where canvasId = $1 order by createdAt desc limit $2
      )
    `, [id, versionLimit])
  }
  await db.execute(
    'update canvases set content = $1, schemaVersion = $2, updatedAt = $3 where id = $4',
    [content, document.schemaVersion, updatedAt, id]
  )
  enqueueCanvasSync('canvas-updated')
  return updatedAt
}

export interface CanvasVersion {
  id: number
  canvasId: string
  document: CanvasDocument
  createdAt: number
}

export async function getCanvasVersions(canvasId: string): Promise<CanvasVersion[]> {
  const db = await getDb()
  const rows = await db.select<Array<{ id: number; canvasId: string; content: string; createdAt: number }>>(
    'select id, canvasId, content, createdAt from canvas_versions where canvasId = $1 order by createdAt desc limit 50',
    [canvasId]
  )
  return rows.map(row => ({
    id: row.id,
    canvasId: row.canvasId,
    document: normalizeCanvasDocument(JSON.parse(row.content) as unknown),
    createdAt: row.createdAt,
  }))
}

export async function renameCanvasProject(id: string, title: string) {
  const db = await getDb()
  const updatedAt = Date.now()
  await db.execute(
    'update canvases set title = $1, updatedAt = $2 where id = $3',
    [title, updatedAt, id]
  )
  enqueueCanvasSync('canvas-renamed')
  return updatedAt
}

export async function updateCanvasThumbnailPath(id: string, thumbnailPath: string | null) {
  const db = await getDb()
  await db.execute('update canvases set thumbnailPath = $1 where id = $2', [thumbnailPath, id])
}

export async function setCanvasPinnedAt(id: string, pinnedAt: number | null) {
  const db = await getDb()
  const updatedAt = Date.now()
  await db.execute(
    'update canvases set pinnedAt = $1, updatedAt = $2 where id = $3',
    [pinnedAt, updatedAt, id]
  )
  enqueueCanvasSync(pinnedAt ? 'canvas-pinned' : 'canvas-unpinned')
  return updatedAt
}

export async function softDeleteCanvasProject(id: string) {
  const db = await getDb()
  const deletedAt = Date.now()
  await db.execute(
    'update canvases set deletedAt = $1, updatedAt = $1 where id = $2',
    [deletedAt, id]
  )
  enqueueCanvasSync('canvas-deleted')
}

export async function restoreCanvasProject(id: string) {
  const db = await getDb()
  const updatedAt = Date.now()
  await db.execute(
    'update canvases set deletedAt = null, updatedAt = $1 where id = $2',
    [updatedAt, id]
  )
  enqueueCanvasSync('canvas-restored')
  return getCanvasProject(id)
}

export async function replaceAllCanvasProjects(projects: CanvasProject[]) {
  const db = await getDb()
  for (const project of projects) {
    await db.execute(
      `insert into canvases
        (id, title, canvasType, schemaVersion, content, thumbnailPath, createdAt, updatedAt, pinnedAt, deletedAt)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict(id) do update set
         title = excluded.title,
         canvasType = excluded.canvasType,
         schemaVersion = excluded.schemaVersion,
         content = excluded.content,
         thumbnailPath = excluded.thumbnailPath,
         createdAt = excluded.createdAt,
         updatedAt = excluded.updatedAt,
         pinnedAt = excluded.pinnedAt,
         deletedAt = excluded.deletedAt`,
      [
        project.id,
        project.title,
        project.canvasType,
        project.schemaVersion,
        JSON.stringify(project.document),
        project.thumbnailPath || null,
        project.createdAt,
        project.updatedAt,
        project.pinnedAt || null,
        project.deletedAt || null,
      ]
    )
  }
  if (projects.length === 0) {
    await db.execute('delete from canvases')
    await db.execute('delete from canvas_versions')
  } else {
    const placeholders = projects.map((_, index) => `$${index + 1}`).join(', ')
    const projectIds = projects.map(project => project.id)
    await db.execute(
      `delete from canvases where id not in (${placeholders})`,
      projectIds
    )
    await db.execute(
      `delete from canvas_versions where canvasId not in (${placeholders})`,
      projectIds
    )
  }
}
