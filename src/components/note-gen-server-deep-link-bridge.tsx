'use client'

import { useEffect } from 'react'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'

import { useNoteGenServerPairingStore } from '@/stores/note-gen-server-pairing'
import { useSettingsDialogStore } from '@/stores/settings-dialog'

export function NoteGenServerDeepLinkBridge() {
  const receivePairingUri = useNoteGenServerPairingStore(state => state.receive)
  const openSettings = useSettingsDialogStore(state => state.openSettings)

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return

    let cancelled = false
    let unlisten: (() => void) | undefined

    const receiveUrls = (urls: string[]) => {
      const pairingUri = urls.find(isNoteGenServerPairingUri)
      if (!pairingUri) return
      receivePairingUri(pairingUri)
      openSettings('sync')
    }

    const register = async () => {
      unlisten = await onOpenUrl(receiveUrls)
      if (cancelled) {
        unlisten()
        return
      }
      const currentUrls = await getCurrent()
      if (currentUrls) receiveUrls(currentUrls)
    }

    void register().catch(error => {
      console.error('Failed to register NoteGen server deep-link listener:', error)
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [openSettings, receivePairingUri])

  return null
}

function isNoteGenServerPairingUri(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'notegen:' && url.hostname === 'sync' && url.pathname === '/pair'
  } catch {
    return false
  }
}
