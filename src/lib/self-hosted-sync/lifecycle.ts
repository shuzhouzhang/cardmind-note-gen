import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { getSelfHostedSyncRuntime } from './runtime'

let listenersInstalled = false

export async function refreshSelfHostedSyncRuntime() {
  const store = await Store.load('store.json')
  const enabled = await store.get<boolean>('experimentalSelfHostedSync') === true
  const selected = await store.get<string>('primaryBackupMethod') === 'selfHosted'
  const runtime = getSelfHostedSyncRuntime()
  if (!enabled || !selected) {
    runtime.stop()
    return
  }
  await invoke<number>('self_hosted_recover_file_journal')
  runtime.start()
  if (listenersInstalled) return
  listenersInstalled = true
  window.addEventListener('online', () => void runtime.wake('network'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void runtime.wake('foreground')
  })
}
