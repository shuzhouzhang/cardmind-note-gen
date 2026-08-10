import { Store } from '@tauri-apps/plugin-store'

import type { PrimarySyncPlatform } from '@/types/sync'

const configWriteQueues = new Map<string, Promise<void>>()

export async function persistSyncTargetConfig<T>(
  key: string,
  provider: PrimarySyncPlatform,
  value: T,
): Promise<void> {
  const previousWrite = configWriteQueues.get(key) ?? Promise.resolve()
  const write = previousWrite.catch(() => undefined).then(() => persistSyncTargetConfigNow(
    key, provider, value,
  ))
  configWriteQueues.set(key, write)
  try {
    await write
  } finally {
    if (configWriteQueues.get(key) === write) configWriteQueues.delete(key)
  }
}

async function persistSyncTargetConfigNow<T>(
  key: string,
  provider: PrimarySyncPlatform,
  value: T,
): Promise<void> {
  const store = await Store.load('store.json')
  const previous = await store.get<T>(key)
  if (JSON.stringify(previous) === JSON.stringify(value)) return

  const activeProvider = await store.get<PrimarySyncPlatform>('primaryBackupMethod') || 'local'
  if (activeProvider !== provider) {
    await store.set(key, value)
    await store.save()
    return
  }

  const [{ getSyncPushQueue }, autoDataSyncQueue] = await Promise.all([
    import('./sync-push-queue'),
    import('./auto-data-sync-queue'),
  ])
  const pushQueue = getSyncPushQueue()
  await Promise.all([
    pushQueue.prepareForWorkspaceSwitch(),
    autoDataSyncQueue.prepareAutoDataSyncForRepositoryChange(),
  ])

  try {
    await store.set(key, value)
    await store.save()
  } finally {
    pushQueue.finishWorkspaceSwitch()
    autoDataSyncQueue.finishAutoDataSyncRepositoryChange()
  }
}
