import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'

import type { NoteGenServerAwarenessState } from '@/lib/sync/note-gen-server-collab'

interface RemotePresenceUpdate extends NoteGenServerAwarenessState {
  deviceId: string
}

type RemotePresenceMeta =
  | { type: 'update', presence: RemotePresenceUpdate }
  | { type: 'remove', deviceId: string }

export const remoteEditorPresencePluginKey = new PluginKey<DecorationSet>('remoteEditorPresence')
interface LocalSelectionGuardState {
  anchor: number
  head: number
  text: boolean
  suppressScroll: boolean
}

const remoteCollaborationScrollGuardKey = new PluginKey<LocalSelectionGuardState>('remoteCollaborationScrollGuard')

export function isRemoteCollaborationTransaction(transaction: Transaction): boolean {
  if (!isChangeOrigin(transaction)) return false
  const metadata = transaction.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined
  return metadata?.isUndoRedoOperation !== true
}

export const RemoteCollaborationScrollGuard = Extension.create({
  name: 'remoteCollaborationScrollGuard',

  addProseMirrorPlugins() {
    return [new Plugin<LocalSelectionGuardState>({
      key: remoteCollaborationScrollGuardKey,
      state: {
        init: (_config, state) => ({
          anchor: state.selection.anchor,
          head: state.selection.head,
          text: state.selection instanceof TextSelection,
          suppressScroll: false,
        }),
        apply(transaction, current, _oldState, newState) {
          if (isRemoteCollaborationTransaction(transaction)) {
            return { ...current, suppressScroll: true }
          }
          if (transaction.selectionSet || transaction.docChanged) {
            return {
              anchor: newState.selection.anchor,
              head: newState.selection.head,
              text: newState.selection instanceof TextSelection,
              suppressScroll: false,
            }
          }
          return { ...current, suppressScroll: false }
        },
      },
      props: {
        // y-prosemirror asks the editor to scroll the restored local selection
        // into view after every remote CRDT update. Suppress that request so a
        // peer typing near the end cannot drag this device's viewport there.
        handleScrollToSelection: view => (
          remoteCollaborationScrollGuardKey.getState(view.state)?.suppressScroll === true
        ),
      },
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some(isRemoteCollaborationTransaction)) return null
        const guarded = remoteCollaborationScrollGuardKey.getState(newState)
        if (!guarded?.text) return null
        const anchor = Math.max(0, Math.min(newState.doc.content.size, guarded.anchor))
        const head = Math.max(0, Math.min(newState.doc.content.size, guarded.head))
        if (newState.selection.anchor === anchor && newState.selection.head === head) return null
        return newState.tr
          .setSelection(TextSelection.between(newState.doc.resolve(anchor), newState.doc.resolve(head)))
          .setMeta('addToHistory', false)
      },
    })]
  },
})

export const RemoteEditorPresence = Extension.create({
  name: 'remoteEditorPresence',

  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: remoteEditorPresencePluginKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, decorations) {
          let next = decorations.map(transaction.mapping, transaction.doc)
          const meta = transaction.getMeta(remoteEditorPresencePluginKey) as RemotePresenceMeta | undefined
          if (!meta) return next
          next = next.remove(next.find(undefined, undefined, spec => spec.deviceId === (
            meta.type === 'update' ? meta.presence.deviceId : meta.deviceId
          )))
          if (meta.type === 'remove') return next
          return next.add(transaction.doc, createPresenceDecorations(meta.presence, transaction.doc.content.size))
        },
      },
      props: {
        decorations: state => remoteEditorPresencePluginKey.getState(state),
      },
    })]
  },
})

export function updateRemoteEditorPresence(
  deviceId: string,
  presence: NoteGenServerAwarenessState,
): RemotePresenceMeta {
  return { type: 'update', presence: { ...presence, deviceId } }
}

export function removeRemoteEditorPresence(deviceId: string): RemotePresenceMeta {
  return { type: 'remove', deviceId }
}

function createPresenceDecorations(
  presence: RemotePresenceUpdate,
  documentSize: number,
): Decoration[] {
  const anchor = clampPosition(presence.anchor, documentSize)
  const head = clampPosition(presence.head, documentSize)
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  const color = colorForDevice(presence.deviceId)
  const decorations: Decoration[] = []
  if (from !== to) {
    decorations.push(Decoration.inline(from, to, {
      class: 'note-gen-remote-selection',
      style: `--remote-presence-color: ${color}`,
    }, { deviceId: presence.deviceId }))
  }
  decorations.push(Decoration.widget(head, () => {
    const caret = document.createElement('span')
    caret.className = 'note-gen-remote-caret'
    caret.style.setProperty('--remote-presence-color', color)
    caret.setAttribute('contenteditable', 'false')
    caret.setAttribute('aria-label', `${presence.label}正在编辑这里`)
    const label = document.createElement('span')
    label.className = 'note-gen-remote-caret-label'
    label.textContent = `${presence.label}正在编辑`
    caret.append(label)
    return caret
  }, {
    side: -1,
    deviceId: presence.deviceId,
    // Especially on iOS, a non-editable widget inside contenteditable can
    // otherwise influence the browser's native DOM selection.
    ignoreSelection: true,
    stopEvent: () => true,
  }))
  return decorations
}

function clampPosition(value: number, documentSize: number): number {
  return Math.max(0, Math.min(documentSize, Math.trunc(value)))
}

function colorForDevice(deviceId: string): string {
  const colors = ['#ef4444', '#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#ec4899']
  let hash = 0
  for (let index = 0; index < deviceId.length; index += 1) {
    hash = ((hash << 5) - hash + deviceId.charCodeAt(index)) | 0
  }
  return colors[Math.abs(hash) % colors.length]
}
