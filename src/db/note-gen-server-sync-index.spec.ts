import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSyncFullyConverged, type SyncHealthSnapshot } from '../lib/sync/sync-health'

const converged: SyncHealthSnapshot = {
  receivedCursor: '42', latestServerSequence: '42', lastSuccessfulSyncAt: null,
  lastServerConfirmedAt: null, lastFullyConvergedAt: null,
  pendingMutations: 0, pendingOutbox: 0, blockedOutbox: 0, pendingInbox: 0,
  failedInbox: 0, unresolvedConflicts: 0, pendingTransfers: 0, failedTransfers: 0,
}

describe('sync convergence status', () => {
  it('requires the received cursor to catch up with the server', () => {
    assert.equal(isSyncFullyConverged({ ...converged, receivedCursor: '41' }), false)
  })

  it('does not report synced while a local mutation has not reached the outbox', () => {
    assert.equal(isSyncFullyConverged({ ...converged, pendingMutations: 1 }), false)
  })

  it('does not report synced while apply, transfer, or conflict work remains', () => {
    assert.equal(isSyncFullyConverged({ ...converged, failedInbox: 1 }), false)
    assert.equal(isSyncFullyConverged({ ...converged, pendingTransfers: 1 }), false)
    assert.equal(isSyncFullyConverged({ ...converged, unresolvedConflicts: 1 }), false)
  })

  it('reports synced only when every durable queue is empty', () => {
    assert.equal(isSyncFullyConverged(converged), true)
  })
})
