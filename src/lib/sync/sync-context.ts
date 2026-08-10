import { Store } from '@tauri-apps/plugin-store'

import { getOptionalSyncRepoName } from './repo-utils'
import type { CloudFolderConfig, S3Config, WebDAVConfig } from '@/types/sync'

const GIT_SYNC_PROVIDERS = ['github', 'gitee', 'gitlab', 'gitea'] as const
type GitSyncProvider = typeof GIT_SYNC_PROVIDERS[number]

function normalizeWorkspacePath(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function isGitSyncProvider(provider: string): provider is GitSyncProvider {
  return GIT_SYNC_PROVIDERS.includes(provider as GitSyncProvider)
}

export async function getCurrentSyncContext() {
  const store = await Store.load('store.json')
  const workspacePath = normalizeWorkspacePath(await store.get<string>('workspacePath') || '')
  const provider = await store.get<string>('primaryBackupMethod') || 'local'
  let repo = ''
  if (isGitSyncProvider(provider)) {
    repo = await getOptionalSyncRepoName(provider)
  } else if (provider === 's3') {
    const config = await store.get<S3Config>('s3SyncConfig')
    repo = JSON.stringify([
      config?.endpoint?.trim() || '',
      config?.region?.trim() || '',
      config?.bucket?.trim() || '',
      config?.pathPrefix?.trim().replace(/^\/+|\/+$/g, '') || '',
    ])
  } else if (provider === 'webdav') {
    const config = await store.get<WebDAVConfig>('webdavSyncConfig')
    repo = JSON.stringify([
      config?.url?.trim().replace(/\/+$/g, '') || '',
      config?.username?.trim() || '',
      config?.pathPrefix?.trim().replace(/^\/+|\/+$/g, '') || '',
    ])
  } else if (provider === 'cloudFolder') {
    const config = await store.get<CloudFolderConfig>('cloudFolderSyncConfig')
    repo = JSON.stringify([
      config?.provider || 'folder',
      config?.path?.trim().replace(/\/+$/g, '') || '',
      config?.oneDriveRootId || '',
      config?.oneDriveWorkspacePath || '',
    ])
  }

  return {
    workspacePath,
    workspaceKey: workspacePath || '__default__',
    provider,
    repo,
  }
}

export async function getSyncMetadataKey(path: string) {
  const context = await getCurrentSyncContext()
  return JSON.stringify([context.workspaceKey, context.provider, context.repo, path])
}
