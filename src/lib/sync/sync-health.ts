export interface SyncHealthSnapshot {
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
  transferCompletedBytes?: string
  transferTotalBytes?: string
  acknowledgedCursor?: string
  lastAckAttemptAt?: number | null
  lastAckError?: string | null
}

export function isSyncFullyConverged(snapshot: SyncHealthSnapshot): boolean {
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
