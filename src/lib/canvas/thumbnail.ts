import { appDataDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, remove, writeFile } from '@tauri-apps/plugin-fs'
import type { CanvasDocument } from '@/types/canvas'
import { canvasDocumentToPngFile } from './static-export'

export async function generateCanvasThumbnail(canvasId: string, document: CanvasDocument) {
  const directory = await join(await appDataDir(), 'canvas-thumbnails')
  await mkdir(directory, { recursive: true })
  const path = await join(directory, `${canvasId}.png`)
  const file = await canvasDocumentToPngFile(document, `${canvasId}.png`, {
    maxDimension: 480,
    scale: 1,
  })
  await writeFile(path, new Uint8Array(await file.arrayBuffer()))
  return path
}

export async function removeCanvasThumbnail(path?: string | null) {
  if (!path || !await exists(path)) return
  await remove(path)
}
