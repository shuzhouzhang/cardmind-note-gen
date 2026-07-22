import { Store } from '@tauri-apps/plugin-store'
import { uploadFile as uploadGithubFile, getFiles as githubGetFiles } from '@/lib/sync/github'
import { uploadFile as uploadGiteeFile, getFiles as giteeGetFiles } from '@/lib/sync/gitee'
import { uploadFile as uploadGitlabFile, getFiles as gitlabGetFiles, getFileContent as gitlabGetFileContent } from '@/lib/sync/gitlab'
import { uploadFile as uploadGiteaFile, getFiles as giteaGetFiles, getFileContent as giteaGetFileContent } from '@/lib/sync/gitea'
import { s3Download, s3Upload } from '@/lib/sync/s3'
import { webdavDownload, webdavUpload } from '@/lib/sync/webdav'
import { decodeBase64ToString, getRemoteFileContent, hasEmptyRemoteFileContent } from '@/lib/sync/remote-file'
import { getSyncRepoName } from '@/lib/sync/repo-utils'
import { normalizeCanvasDocument, type CanvasProject, type CanvasProjectType } from '@/types/canvas'
import type { S3Config, WebDAVConfig } from '@/types/sync'

export const CANVAS_SYNC_PATH = '.data/canvases.json'

function normalizeRemoteCanvasProject(value: unknown): CanvasProject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string'
    || typeof candidate.title !== 'string'
    || typeof candidate.createdAt !== 'number'
    || typeof candidate.updatedAt !== 'number') return null
  const canvasTypes = new Set<CanvasProjectType>([
    'blank', 'flowchart', 'mindmap', 'timeline', 'quadrant', 'kanban', 'swot',
  ])
  const canvasType: CanvasProjectType = canvasTypes.has(candidate.canvasType as CanvasProjectType)
    ? candidate.canvasType as CanvasProjectType
    : 'blank'
  return {
    id: candidate.id,
    title: candidate.title,
    canvasType,
    schemaVersion: 1,
    document: normalizeCanvasDocument(candidate.document),
    thumbnailPath: null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    pinnedAt: typeof candidate.pinnedAt === 'number' ? candidate.pinnedAt : null,
    deletedAt: typeof candidate.deletedAt === 'number' ? candidate.deletedAt : null,
  }
}

function mergeCanvasProjects(
  local: CanvasProject[],
  remote: CanvasProject[],
  lastSyncedVersions: Record<string, number>
) {
  const projects = new Map(local.map(project => [project.id, project]))
  for (const remoteProject of remote) {
    const localProject = projects.get(remoteProject.id)
    if (!localProject) {
      projects.set(remoteProject.id, { ...remoteProject, thumbnailPath: null })
      continue
    }
    const documentsMatch = JSON.stringify(localProject.document) === JSON.stringify(remoteProject.document)
    const normalizedRemoteProject: CanvasProject = {
      ...remoteProject,
      thumbnailPath: documentsMatch ? localProject.thumbnailPath || null : null,
    }
    const baseVersion = lastSyncedVersions[remoteProject.id] || 0
    const hasConflict = baseVersion > 0
      && localProject.updatedAt > baseVersion
      && remoteProject.updatedAt > baseVersion
      && localProject.updatedAt !== remoteProject.updatedAt && (
      localProject.title !== remoteProject.title
      || !documentsMatch
      || localProject.pinnedAt !== remoteProject.pinnedAt
      || localProject.deletedAt !== remoteProject.deletedAt
    )
    if (hasConflict) {
      const older = remoteProject.updatedAt >= localProject.updatedAt ? localProject : normalizedRemoteProject
      const origin = older === localProject ? '本地' : '远程'
      const conflictId = `${older.id}-conflict-${origin === '本地' ? 'local' : 'remote'}-${older.updatedAt}`
      if (!projects.has(conflictId)) {
        projects.set(conflictId, {
          ...structuredClone(older),
          id: conflictId,
          title: `${older.title}（同步冲突·${origin}副本）`,
          pinnedAt: null,
          thumbnailPath: origin === '本地' ? older.thumbnailPath || null : null,
          deletedAt: null,
        })
      }
    }
    if (remoteProject.updatedAt >= localProject.updatedAt) {
      projects.set(remoteProject.id, normalizedRemoteProject)
    }
  }
  return Array.from(projects.values())
}

export async function uploadCanvases() {
  const { getCanvasProjects } = await import('@/db/canvases')
  const projects = await getCanvasProjects({ includeDeleted: true })
  const content = JSON.stringify(projects.map(project => ({
    ...project,
    thumbnailPath: null,
  })))
  const store = await Store.load('store.json')
  const provider = await store.get<string>('primaryBackupMethod') || 'github'

  let success = false
  switch (provider) {
    case 'github': {
      const repo = await getSyncRepoName('github')
      const existing = await githubGetFiles({ path: CANVAS_SYNC_PATH, repo })
      success = Boolean(await uploadGithubFile({ file: content, repo, path: CANVAS_SYNC_PATH, sha: existing?.sha }))
      break
    }
    case 'gitee': {
      const repo = await getSyncRepoName('gitee')
      const existing = await giteeGetFiles({ path: CANVAS_SYNC_PATH, repo })
      success = Boolean(await uploadGiteeFile({ file: content, repo, path: CANVAS_SYNC_PATH, sha: existing?.sha }))
      break
    }
    case 'gitlab': {
      const repo = await getSyncRepoName('gitlab')
      const files = await gitlabGetFiles({ path: '.data', repo })
      const existing = Array.isArray(files) ? files.find(file => file.name === 'canvases.json') : undefined
      success = Boolean(await uploadGitlabFile({ file: content, repo, path: '.data', filename: 'canvases.json', sha: existing?.sha || '' }))
      break
    }
    case 'gitea': {
      const repo = await getSyncRepoName('gitea')
      const files = await giteaGetFiles({ path: '.data', repo })
      const existing = Array.isArray(files) ? files.find(file => file.name === 'canvases.json') : undefined
      success = Boolean(await uploadGiteaFile({ file: content, repo, path: '.data', filename: 'canvases.json', sha: existing?.sha || '' }))
      break
    }
    case 's3': {
      const config = await store.get<S3Config>('s3SyncConfig')
      success = config ? Boolean(await s3Upload(config, CANVAS_SYNC_PATH, content)) : false
      break
    }
    case 'webdav': {
      const config = await store.get<WebDAVConfig>('webdavSyncConfig')
      success = config ? Boolean(await webdavUpload(config, CANVAS_SYNC_PATH, content)) : false
      break
    }
    default:
      success = false
  }
  if (success) {
    await store.set('canvasSyncVersions', Object.fromEntries(projects.map(project => [project.id, project.updatedAt])))
    await store.save()
  }
  return success
}

export async function downloadCanvases(options: { allowMissingRemote?: boolean } = {}) {
  const { getCanvasProjects, replaceAllCanvasProjects } = await import('@/db/canvases')
  const store = await Store.load('store.json')
  const provider = await store.get<string>('primaryBackupMethod') || 'github'
  let content: string | null = null

  try {
    switch (provider) {
      case 'github': {
        const repo = await getSyncRepoName('github')
        const file = await githubGetFiles({ path: CANVAS_SYNC_PATH, repo })
        if (!hasEmptyRemoteFileContent(file)) content = decodeBase64ToString(getRemoteFileContent(file, CANVAS_SYNC_PATH))
        break
      }
      case 'gitee': {
        const repo = await getSyncRepoName('gitee')
        const file = await giteeGetFiles({ path: CANVAS_SYNC_PATH, repo })
        if (!hasEmptyRemoteFileContent(file)) content = decodeBase64ToString(getRemoteFileContent(file, CANVAS_SYNC_PATH))
        break
      }
      case 'gitlab': {
        const repo = await getSyncRepoName('gitlab')
        const file = await gitlabGetFileContent({ path: CANVAS_SYNC_PATH, ref: 'main', repo })
        if (!hasEmptyRemoteFileContent(file)) content = decodeBase64ToString(getRemoteFileContent(file, CANVAS_SYNC_PATH))
        break
      }
      case 'gitea': {
        const repo = await getSyncRepoName('gitea')
        const file = await giteaGetFileContent({ path: CANVAS_SYNC_PATH, ref: 'main', repo })
        if (!hasEmptyRemoteFileContent(file)) content = decodeBase64ToString(getRemoteFileContent(file, CANVAS_SYNC_PATH))
        break
      }
      case 's3': {
        const config = await store.get<S3Config>('s3SyncConfig')
        content = config ? (await s3Download(config, CANVAS_SYNC_PATH))?.content || null : null
        break
      }
      case 'webdav': {
        const config = await store.get<WebDAVConfig>('webdavSyncConfig')
        content = config ? (await webdavDownload(config, CANVAS_SYNC_PATH))?.content || null : null
        break
      }
    }
  } catch (error) {
    if (!options.allowMissingRemote) throw error
    return getCanvasProjects({ includeDeleted: true })
  }

  if (!content) return getCanvasProjects({ includeDeleted: true })
  const parsed: unknown = JSON.parse(content)
  if (!Array.isArray(parsed)) throw new Error('Invalid remote canvas data')
  const local = await getCanvasProjects({ includeDeleted: true })
  const remoteProjects = parsed.map(normalizeRemoteCanvasProject)
  if (remoteProjects.some(project => project === null)) throw new Error('Invalid remote canvas project')
  const normalizedRemoteProjects = remoteProjects.filter((project): project is CanvasProject => project !== null)
  const lastSyncedVersions = await store.get<Record<string, number>>('canvasSyncVersions') || {}
  const merged = mergeCanvasProjects(local, normalizedRemoteProjects, lastSyncedVersions)
  await replaceAllCanvasProjects(merged)
  await store.set('canvasSyncVersions', Object.fromEntries(merged.map(project => [project.id, project.updatedAt])))
  await store.save()
  return merged
}
