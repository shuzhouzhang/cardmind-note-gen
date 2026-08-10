export interface SyncV2HealthSnapshot {
  receivedCursor: string
  latestServerSequence: string
  lastServerConfirmedAt: number | null
  lastFullyConvergedAt: number | null
  /** @deprecated Compatibility alias for lastFullyConvergedAt. */
  lastSuccessfulSyncAt: number | null
  pendingMutations: number
  pendingOutbox: number
  blockedOutbox: number
  pendingInbox: number
  failedInbox: number
  unresolvedConflicts: number
  pendingTransfers: number
  failedTransfers: number
}

export function isSyncV2FullyConverged(snapshot: SyncV2HealthSnapshot): boolean {
  return snapshot.receivedCursor === snapshot.latestServerSequence
    && snapshot.pendingMutations === 0
    && snapshot.pendingOutbox === 0
    && snapshot.blockedOutbox === 0
    && snapshot.pendingInbox === 0
    && snapshot.failedInbox === 0
    && snapshot.unresolvedConflicts === 0
    && snapshot.pendingTransfers === 0
    && snapshot.failedTransfers === 0
}
