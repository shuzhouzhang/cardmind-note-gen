import assert from 'node:assert/strict'
import test from 'node:test'
import { awaitAgentHandlerCallback } from './agent-handler-callbacks'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('handler callback adapter waits for asynchronous completion', async () => {
  const callbackStarted = deferred()
  const releaseCallback = deferred()

  const invocation = awaitAgentHandlerCallback(async (value: string) => {
    assert.equal(value, 'done')
    callbackStarted.resolve()
    await releaseCallback.promise
  }, 'done')

  await callbackStarted.promise

  let settled = false
  void invocation.then(
    () => { settled = true },
    () => { settled = true }
  )
  await Promise.resolve()

  assert.equal(settled, false)
  releaseCallback.resolve()
  await invocation
})

test('handler callback adapter keeps persistence failures on the returned promise', async () => {
  const persistenceError = new Error('persist failed')

  const invocation = awaitAgentHandlerCallback(async () => {
    throw persistenceError
  })

  await assert.rejects(invocation, (error) => error === persistenceError)
})
