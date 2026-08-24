'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { retry } = require('../retry')

// ---- Helpers ---------------------------------------------------------------

// sleep() is not injectable, so every test passes baseDelayMs: 0 — the 500ms
// default would make this file sleep for seconds on the failure paths.
const noDelay = { baseDelayMs: 0 }

// Fails the first `failures` calls, then resolves with `value`. Records the call count.
const makeFlaky = (failures, value = 'ok') => {
  const state = { calls: 0 }
  const fn = async () => {
    state.calls++
    if (state.calls <= failures) throw new Error(`attempt ${state.calls} failed`)
    return value
  }
  return { fn, state }
}

// =====================================================================
// retry — wraps the Pureservice calls made by the change stream watcher, so
// its attempt counting decides whether a transient 429 recovers or the event
// falls through to the dead letter queue.
// =====================================================================

describe('retry', () => {
  test('returns the value and calls the function once when it succeeds immediately', async () => {
    const { fn, state } = makeFlaky(0, 'first try')

    const result = await retry(fn, noDelay)

    assert.equal(result, 'first try')
    assert.equal(state.calls, 1)
  })

  test('retries after a failure and returns the value from the successful attempt', async () => {
    const { fn, state } = makeFlaky(1, 'second try')

    const result = await retry(fn, noDelay)

    assert.equal(result, 'second try')
    assert.equal(state.calls, 2)
  })

  test('keeps retrying up to the default of three attempts', async () => {
    const { fn, state } = makeFlaky(2, 'third try')

    const result = await retry(fn, noDelay)

    assert.equal(result, 'third try')
    assert.equal(state.calls, 3)
  })

  test('rejects once the attempts are exhausted', async () => {
    const { fn } = makeFlaky(99)

    await assert.rejects(() => retry(fn, noDelay), /attempt 3 failed/)
  })

  test('rejects with the error from the last attempt, not the first', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new Error(`error-${calls}`)
    }

    await assert.rejects(() => retry(fn, { maxAttempts: 3, baseDelayMs: 0 }), (err) => {
      assert.equal(err.message, 'error-3')
      return true
    })
  })

  test('calls the function exactly maxAttempts times before giving up', async () => {
    const { fn, state } = makeFlaky(99)

    await assert.rejects(() => retry(fn, { maxAttempts: 5, baseDelayMs: 0 }))

    assert.equal(state.calls, 5)
  })

  test('honours a maxAttempts of 1 — no retry at all', async () => {
    const { fn, state } = makeFlaky(99)

    await assert.rejects(() => retry(fn, { maxAttempts: 1, baseDelayMs: 0 }))

    assert.equal(state.calls, 1)
  })

  test('works with no options argument at all, applying the defaults', async () => {
    // Covers the `opts = {}` default. Kept on the success path so the suite does not
    // sit through the real 500ms/1000ms backoff.
    const { fn, state } = makeFlaky(0, 'no opts')

    const result = await retry(fn)

    assert.equal(result, 'no opts')
    assert.equal(state.calls, 1)
  })

  test('applies the default backoff delay when only maxAttempts is overridden', async () => {
    const { fn, state } = makeFlaky(1, 'delayed success')
    const startedAt = process.hrtime.bigint()

    const result = await retry(fn, { maxAttempts: 2 })
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    assert.equal(result, 'delayed success')
    assert.equal(state.calls, 2)
    assert.ok(elapsedMs >= 400, `expected the default 500ms backoff, waited ${Math.round(elapsedMs)}ms`)
  })

  test('passes through a resolved object reference unchanged', async () => {
    const payload = { pusId: 42, patch: { cf_2: '{}' } }

    const result = await retry(async () => payload, noDelay)

    assert.equal(result, payload)
  })

  test('propagates a non-Error rejection value', async () => {
    await assert.rejects(() => retry(async () => { throw new Error('boom') }, { maxAttempts: 2, baseDelayMs: 0 }), /boom/)
  })

  test('a synchronous throw inside the function is retried like a rejection', async () => {
    let calls = 0
    const fn = () => {
      calls++
      if (calls < 2) throw new Error('sync throw')
      return 'recovered'
    }

    const result = await retry(fn, noDelay)

    assert.equal(result, 'recovered')
    assert.equal(calls, 2)
  })
})
