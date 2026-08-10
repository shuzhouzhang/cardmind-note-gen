import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSyncV2FullyConverged, type SyncV2HealthSnapshot } from '../lib/sync/sync-health'

const converged: SyncV2HealthSnapshot = {
  receivedCursor: '42', latestServerSequence: '42', lastSuccessfulSyncAt: null,
  lastServerConfirmedAt: null, lastFullyConvergedAt: null,
  pendingMutations: 0, pendingOutbox: 0, blockedOutbox: 0, pendingInbox: 0,
  failedInbox: 0, unresolvedConflicts: 0, pendingTransfers: 0, failedTransfers: 0,
}

describe('sync v2 convergence status', () => {
  it('requires the received cursor to catch up with the server', () => {
    assert.equal(isSyncV2FullyConverged({ ...converged, receivedCursor: '41' }), false)
  })

  it('does not report synced while a local mutation has not reached the outbox', () => {
    assert.equal(isSyncV2FullyConverged({ ...converged, pendingMutations: 1 }), false)
  })

  it('does not report synced while apply, transfer, or conflict work remains', () => {
    assert.equal(isSyncV2FullyConverged({ ...converged, failedInbox: 1 }), false)
    assert.equal(isSyncV2FullyConverged({ ...converged, pendingTransfers: 1 }), false)
    assert.equal(isSyncV2FullyConverged({ ...converged, unresolvedConflicts: 1 }), false)
  })

  it('reports synced only when every durable queue is empty', () => {
    assert.equal(isSyncV2FullyConverged(converged), true)
  })
})
