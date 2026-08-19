import * as Y from 'yjs'
import { getDb } from '@/db'
import type { CanvasDocument } from '@/types/canvas'
import { enqueueCanvasSnapshot } from './outbox'
import { openCollaborativeObject } from './collaboration'

const LOCAL_ORIGIN = Symbol('notegen-canvas-local')
const REMOTE_ORIGIN = Symbol('notegen-canvas-remote')

interface CanvasSession {
  document: Y.Doc
  nodes: Y.Map<string>
  edges: Y.Map<string>
  metadata: Y.Map<string>
  transport: Awaited<ReturnType<typeof openCollaborativeObject>>
  unsubscribePresence: () => void
}

const sessions = new Map<string, Promise<CanvasSession | null>>()

export async function syncCanvasDocument(canvasId: string, value: CanvasDocument) {
  const session = await getCanvasSession(canvasId, value)
  if (!session) return
  session.document.transact(() => {
    reconcileMap(session.nodes, value.nodes.map(node => [node.id, JSON.stringify(node)]))
    reconcileMap(session.edges, value.edges.map(edge => [edge.id, JSON.stringify(edge)]))
    session.metadata.set('schemaVersion', String(value.schemaVersion))
    session.metadata.set('viewport', JSON.stringify(value.viewport))
    session.metadata.set('settings', JSON.stringify(value.settings))
  }, LOCAL_ORIGIN)
}

export async function closeCanvasCollaboration(canvasId: string) {
  const session = await sessions.get(canvasId)
  sessions.delete(canvasId)
  if (!session) return
  session.transport.close()
  session.unsubscribePresence()
  session.document.destroy()
}

export async function updateCanvasDragPresence(
  canvasId: string,
  nodes: Array<{ id: string; position: { x: number; y: number } }>,
) {
  const session = await sessions.get(canvasId)
  if (!session) return
  session.transport.updateCanvasPresence(
    nodes.slice(0, 100).map(node => ({ id: node.id, x: node.position.x, y: node.position.y })),
    'NoteGen',
  )
}

export async function clearCanvasDragPresence(canvasId: string) {
  const session = await sessions.get(canvasId)
  if (session) session.transport.updateCanvasPresence([], 'NoteGen')
}

async function getCanvasSession(canvasId: string, initial: CanvasDocument) {
  const existing = sessions.get(canvasId)
  if (existing) return existing
  const created = createCanvasSession(canvasId, initial)
  sessions.set(canvasId, created)
  return created
}

async function createCanvasSession(canvasId: string, initial: CanvasDocument): Promise<CanvasSession | null> {
  const workspaceId = await enqueueCanvasSnapshot(canvasId)
  if (!workspaceId) return null
  const database = await getDb()
  const mappings = await database.select<Array<{ objectId: string }>>(
    `select object_id as objectId from self_hosted_object_mappings
     where workspace_id = $1 and kind = 'canvas' and local_identity = $2 limit 1`,
    [workspaceId, `canvas:${canvasId}`]
  )
  const objectId = mappings[0]?.objectId ?? crypto.randomUUID()
  if (!mappings[0]) {
    await database.execute(
      `insert into self_hosted_object_mappings(
         workspace_id, object_id, kind, local_identity, updated_at
       ) values ($1, $2, 'canvas', $3, $4)`,
      [workspaceId, objectId, `canvas:${canvasId}`, Date.now()]
    )
  }
  const transport = await openCollaborativeObject(workspaceId, objectId, objectId, 'canvas')
  const document = new Y.Doc()
  const session: CanvasSession = {
    document,
    nodes: document.getMap('nodes'),
    edges: document.getMap('edges'),
    metadata: document.getMap('metadata'),
    transport,
    unsubscribePresence: () => {},
  }
  document.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE_ORIGIN) void transport.appendUpdate(update)
  })
  await transport.consume(update => Y.applyUpdate(document, update, REMOTE_ORIGIN))
  if (session.nodes.size === 0 && session.edges.size === 0) {
    await syncCanvasIntoSession(session, initial)
  }
  const applyRemote = async () => {
    await transport.consume(update => Y.applyUpdate(document, update, REMOTE_ORIGIN))
    const next = materializeCanvas(session, initial)
    const { default: useCanvasStore } = await import('@/stores/canvas')
    useCanvasStore.getState().updateDocument(canvasId, next)
  }
  session.unsubscribePresence = transport.subscribePresence(message => {
    if (message.type === 'inbox.applied') void applyRemote()
  })
  return session
}

async function syncCanvasIntoSession(session: CanvasSession, value: CanvasDocument) {
  session.document.transact(() => {
    reconcileMap(session.nodes, value.nodes.map(node => [node.id, JSON.stringify(node)]))
    reconcileMap(session.edges, value.edges.map(edge => [edge.id, JSON.stringify(edge)]))
    session.metadata.set('schemaVersion', String(value.schemaVersion))
    session.metadata.set('viewport', JSON.stringify(value.viewport))
    session.metadata.set('settings', JSON.stringify(value.settings))
  }, LOCAL_ORIGIN)
}

function materializeCanvas(session: CanvasSession, fallback: CanvasDocument): CanvasDocument {
  return {
    schemaVersion: 1,
    nodes: [...session.nodes.values()].map(value => JSON.parse(value)),
    edges: [...session.edges.values()].map(value => JSON.parse(value)),
    viewport: JSON.parse(session.metadata.get('viewport') ?? JSON.stringify(fallback.viewport)),
    settings: JSON.parse(session.metadata.get('settings') ?? JSON.stringify(fallback.settings)),
  }
}

function reconcileMap(target: Y.Map<string>, values: Array<[string, string]>) {
  const keys = new Set(values.map(([key]) => key))
  for (const key of target.keys()) if (!keys.has(key)) target.delete(key)
  for (const [key, value] of values) if (target.get(key) !== value) target.set(key, value)
}
