'use client'

export type AutoDataSyncDomain = 'records' | 'settings' | 'conversations'
export type AutoDataSyncMode = 'auto' | 'manual'

let applyingRemoteDepth = 0

export function setAutoDataSyncApplyingRemote(value: boolean): void {
  applyingRemoteDepth = value
    ? applyingRemoteDepth + 1
    : Math.max(0, applyingRemoteDepth - 1)
}

export function isAutoDataSyncApplyingRemote(): boolean {
  return applyingRemoteDepth > 0
}

export function enqueueAutoDataSync(
  domain: AutoDataSyncDomain,
  reason = 'change',
  mode: AutoDataSyncMode = 'auto',
): void {
  if (isAutoDataSyncApplyingRemote()) return
  void import('./auto-data-sync-queue').then(module => {
    module.enqueueAutoDataSync(domain, reason, mode)
  }).catch(error => {
    console.error('Failed to load automatic data sync queue:', error)
  })
}
