import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { getDb } from '@/db'
import { getDefaultArticleAbsolutePath, getWorkspacePath } from '@/lib/workspace'

export async function moveSelfHostedWorkspacePath(sourceRelativePath: string, targetRelativePath: string) {
  const store = await Store.load('store.json')
  if (await store.get<string>('primaryBackupMethod') !== 'selfHosted') return false
  const workspace = await getWorkspacePath()
  const workspaceRoot = workspace.isCustom ? workspace.path : await getDefaultArticleAbsolutePath('')
  const database = await getDb()
  const bindings = await database.select<Array<{ workspaceId: string }>>(
    `select workspace_id as workspaceId from self_hosted_workspace_bindings
     where local_root = $1 and binding_state = 'bound' limit 1`,
    [workspaceRoot]
  )
  const workspaceId = bindings[0]?.workspaceId
  if (!workspaceId) return false
  await invoke('self_hosted_move_path', {
    workspaceId,
    workspaceRoot,
    sourceRelativePath,
    targetRelativePath,
  })
  return true
}

export async function writeSelfHostedWorkspaceText(relativePath: string, content: string) {
  const binding = await activeBinding()
  if (!binding) return false
  const database = await getDb()
  const mappings = await database.select<Array<{ objectId: string }>>(
    `select object_id as objectId from self_hosted_object_mappings
     where workspace_id = $1 and relative_path = $2 and deleted_at is null limit 1`,
    [binding.workspaceId, relativePath]
  )
  const bytes = new TextEncoder().encode(content)
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  await invoke('self_hosted_atomic_write', {
    workspaceId: binding.workspaceId,
    objectId: mappings[0]?.objectId ?? null,
    workspaceRoot: binding.workspaceRoot,
    relativePath,
    contents: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
    expectedHash: await invoke<string>('self_hosted_sha256', { value: content }),
  })
  return true
}

export async function deleteSelfHostedWorkspacePath(relativePath: string) {
  const binding = await activeBinding()
  if (!binding) return false
  const database = await getDb()
  const mappings = await database.select<Array<{
    objectId: string
    kind: string
    contentHash: string | null
  }>>(
    `select object_id as objectId, kind, content_hash as contentHash
     from self_hosted_object_mappings where workspace_id = $1 and relative_path = $2
       and deleted_at is null limit 1`,
    [binding.workspaceId, relativePath]
  )
  const mapping = mappings[0]
  if (mapping?.kind === 'folder') {
    await invoke('self_hosted_delete_directory', {
      workspaceId: binding.workspaceId,
      objectId: mapping.objectId,
      workspaceRoot: binding.workspaceRoot,
      relativePath,
      allowNonEmpty: true,
    })
  } else {
    await invoke('self_hosted_delete_file', {
      workspaceId: binding.workspaceId,
      objectId: mapping?.objectId ?? null,
      workspaceRoot: binding.workspaceRoot,
      relativePath,
      expectedHash: null,
    })
  }
  return true
}

async function activeBinding() {
  const store = await Store.load('store.json')
  if (await store.get<string>('primaryBackupMethod') !== 'selfHosted') return null
  const workspace = await getWorkspacePath()
  const workspaceRoot = workspace.isCustom ? workspace.path : await getDefaultArticleAbsolutePath('')
  const database = await getDb()
  const bindings = await database.select<Array<{ workspaceId: string }>>(
    `select workspace_id as workspaceId from self_hosted_workspace_bindings
     where local_root = $1 and binding_state = 'bound' limit 1`,
    [workspaceRoot]
  )
  return bindings[0] ? { ...bindings[0], workspaceRoot } : null
}
