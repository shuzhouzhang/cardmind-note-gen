import * as Y from 'yjs'
import { openCollaborativeDocument } from './collaboration'

const LOCAL_ORIGIN = Symbol('notegen-local-editor')
const REMOTE_ORIGIN = Symbol('notegen-remote-sync')

export interface MarkdownCollaborationController {
  applyLocal(markdown: string): void
  updatePresence(anchor: number, head: number, label: string): void
  subscribePresence(listener: (message: Record<string, unknown>) => void): () => void
  close(): void
}

export async function openMarkdownCollaboration(
  localRoot: string,
  relativePath: string,
  initialMarkdown: string,
  onRemoteMarkdown: (markdown: string) => void,
): Promise<MarkdownCollaborationController> {
  const transport = await openCollaborativeDocument(localRoot, relativePath)
  const document = new Y.Doc()
  const text = document.getText('markdown')
  let closed = false
  let consumedRemoteState = false
  let localUpdateCount = 0
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null

  document.on('update', (update: Uint8Array, origin: unknown) => {
    if (closed || origin === REMOTE_ORIGIN) return
    void transport.appendUpdate(update)
    localUpdateCount++
    if (localUpdateCount >= 100) void checkpoint()
    else if (!checkpointTimer) checkpointTimer = setTimeout(() => void checkpoint(), 5 * 60_000)
  })

  await transport.consume(update => {
    consumedRemoteState = true
    Y.applyUpdate(document, update, REMOTE_ORIGIN)
  })
  if (!consumedRemoteState && text.length === 0 && initialMarkdown) {
    const seed = new Y.Doc()
    seed.clientID = deterministicClientId(`${transport.workspaceId}:${transport.objectId}:markdown-seed`)
    seed.getText('markdown').insert(0, initialMarkdown)
    Y.applyUpdate(document, Y.encodeStateAsUpdate(seed), REMOTE_ORIGIN)
    seed.destroy()
  }

  text.observe((_event, transaction) => {
    if (transaction.origin === LOCAL_ORIGIN || closed) return
    onRemoteMarkdown(text.toString())
  })

  const stopRealtime = transport.subscribePresence(message => {
    if (message.type === 'document.sync-request' || message.type === 'inbox.applied') {
      void transport.consume(update => Y.applyUpdate(document, update, REMOTE_ORIGIN))
    }
  })

  async function checkpoint() {
    if (closed) return
    localUpdateCount = 0
    if (checkpointTimer) clearTimeout(checkpointTimer)
    checkpointTimer = null
    await transport.checkpoint(Y.encodeStateAsUpdate(document))
  }

  return {
    applyLocal(markdown) {
      if (markdown === text.toString()) return
      const previous = text.toString()
      const prefix = commonPrefix(previous, markdown)
      const suffix = commonSuffix(previous, markdown, prefix)
      document.transact(() => {
        const removed = previous.length - prefix - suffix
        if (removed > 0) text.delete(prefix, removed)
        const inserted = markdown.slice(prefix, markdown.length - suffix)
        if (inserted) text.insert(prefix, inserted)
      }, LOCAL_ORIGIN)
    },
    updatePresence: transport.updatePresence,
    subscribePresence: transport.subscribePresence,
    close() {
      closed = true
      if (checkpointTimer) clearTimeout(checkpointTimer)
      stopRealtime()
      transport.close()
      document.destroy()
    },
  }
}

function deterministicClientId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

function commonPrefix(left: string, right: string) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index++
  return index
}

function commonSuffix(left: string, right: string, prefix: number) {
  const limit = Math.min(left.length, right.length) - prefix
  let index = 0
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) index++
  return index
}
