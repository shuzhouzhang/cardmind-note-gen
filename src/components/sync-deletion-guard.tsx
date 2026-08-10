'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import emitter from '@/lib/emitter'

type DeletedObject = {
  kind: 'note' | 'folder' | 'mark' | 'canvas'
  path?: string
  localId?: string | number
}

export function SyncDeletionGuard() {
  const router = useRouter()

  useEffect(() => {
    const handleDeleted = async (event: DeletedObject) => {
      const articleModule = await import('@/stores/article')
      const article = articleModule.default.getState()
      if (event.kind === 'note' && event.path) {
        articleModule.discardArticlePathFromSync(event.path)
        await article.cleanTabsByDeletedFile(event.path)
        return
      }
      if (event.kind === 'folder' && event.path) {
        articleModule.discardArticlePathFromSync(event.path, true)
        await article.cleanTabsByDeletedFolder(event.path)
        return
      }
      if (event.kind === 'mark' && typeof event.localId === 'number') {
        const existing = await import('@/db/marks').then(module => module.getMarkById(event.localId as number))
        if (existing) return
        await article.cleanTabsByDeletedFile(`record://mark/${event.localId}`)
        const mark = await import('@/stores/mark').then(module => module.default.getState())
        if (mark.activeMarkId === event.localId) mark.clearActiveMark()
        const url = new URL(window.location.href)
        if (url.pathname === '/mobile/record/detail'
          && Number(url.searchParams.get('id')) === event.localId) {
          router.replace('/mobile/record')
        }
        return
      }
      if (event.kind === 'canvas' && typeof event.localId === 'string') {
        const existing = await import('@/db/canvases').then(module => module.getCanvasProject(event.localId as string))
        if (existing) return
        await article.cleanTabsByDeletedFile(`canvas://project/${event.localId}`)
        const canvas = await import('@/stores/canvas').then(module => module.default.getState())
        if (canvas.activeCanvasId === event.localId) canvas.setActiveCanvasId(null)
        const url = new URL(window.location.href)
        if (url.pathname === '/mobile/canvas/editor'
          && url.searchParams.get('id') === event.localId) {
          router.replace('/mobile/canvas')
        }
      }
    }

    emitter.on('sync-object-deleted', handleDeleted)
    return () => emitter.off('sync-object-deleted', handleDeleted)
  }, [router])

  return null
}
