'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { updatePCStatus } = require('../updatePCStatus.js')

const makeContract = (overrides = {}) => ({
  _id: { toString: () => 'contract-id-001' },
  pureserviceId: 'ps-123',
  ...overrides,
})

const makeDeps = (overrides = {}) => ({
  getDocumentsFn: async () => ({ status: 200, result: [makeContract()] }),
  updateContractPCStatusFn: async () => ({ status: 200, message: 'ok' }),
  ...overrides,
})

describe('updatePCStatus', () => {
  // --- Status mapping ---
  test('utlevering sets releasePC: true on the update call', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(captured.releasePC, 'true')
  })

  test('innlevering sets returnPC: true on the update call', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','innlevering', undefined, deps)
    assert.equal(captured.returnPC, 'true')
  })

  test('utkjøp sets buyOutPC: true on the update call', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','utkjøp', undefined, deps)
    assert.equal(captured.buyOutPC, 'true')
  })

  // --- Case normalization ---
  test('Innlevering (capitalized) is accepted and treated as innlevering', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','Innlevering', undefined, deps)
    assert.equal(captured.returnPC, 'true')
  })

  test('UtKjøp (mixed case) is accepted and treated as utkjøp', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','UtKjøp', undefined, deps)
    assert.equal(captured.buyOutPC, 'true')
  })

  test('Utlevering (capitalized) is accepted and treated as utlevering', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','Utlevering', undefined, deps)
    assert.equal(captured.releasePC, 'true')
  })

  // --- requestMadeBy / upn ---
  test('upn uses requestMadeBy when provided', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','utlevering', 'agent@pureservice.no', deps)
    assert.equal(captured.upn, 'agent@pureservice.no')
  })

  test('upn falls back to pureservice when requestMadeBy is absent', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(captured.upn, 'pureservice')
  })

  test('upn falls back to pureservice when requestMadeBy is empty string', async () => {
    let captured
    const deps = makeDeps({ updateContractPCStatusFn: async (c) => { captured = c; return {} } })
    await updatePCStatus('123','utlevering', '', deps)
    assert.equal(captured.upn, 'pureservice')
  })

  // --- contractID is passed correctly ---
  test('contractID is the string form of the found document _id', async () => {
    let captured
    const contract = makeContract({ _id: { toString: () => 'specific-id-xyz' } })
    const deps = makeDeps({
      getDocumentsFn: async () => ({ status: 200, result: [contract] }),
      updateContractPCStatusFn: async (c) => { captured = c; return {} },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(captured.contractID, 'specific-id-xyz')
  })

  // --- Collection routing ---
  test('looks in kontrakter first', async () => {
    const calls = []
    const deps = makeDeps({
      getDocumentsFn: async (query, type) => { calls.push(type); return { status: 200, result: [makeContract()] } },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(calls[0], 'regular')
  })

  test('falls back to pcIkkeInnlevert when not found in kontrakter', async () => {
    const calls = []
    const deps = makeDeps({
      getDocumentsFn: async (query, type) => {
        calls.push(type)
        if (type === 'regular') return { status: 404, error: 'Fant ingen dokumenter' }
        return { status: 200, result: [makeContract()] }
      },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.deepEqual(calls, ['regular', 'pcIkkeInnlevert'])
  })

  test('passes targetCollection=pcIkkeInnlevert when contract is in historic collection', async () => {
    let capturedTarget
    const deps = makeDeps({
      getDocumentsFn: async (q, type) => type === 'regular' ? { status: 404, error: 'Fant ingen dokumenter' } : { status: 200, result: [makeContract()] },
      updateContractPCStatusFn: async (c, mock, target) => { capturedTarget = target; return {} },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(capturedTarget, 'pcIkkeInnlevert')
  })

  test('passes targetCollection=undefined when contract is in kontrakter', async () => {
    let capturedTarget
    const deps = makeDeps({
      updateContractPCStatusFn: async (c, mock, target) => { capturedTarget = target; return {} },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(capturedTarget, undefined)
  })

  test('passes isMock=false to updateContractPCStatus', async () => {
    let capturedMock
    const deps = makeDeps({
      updateContractPCStatusFn: async (c, mock) => { capturedMock = mock; return {} },
    })
    await updatePCStatus('123','utlevering', undefined, deps)
    assert.equal(capturedMock, false)
  })

  // --- studentId parsing ---
  test('parses string studentId to integer for the query', async () => {
    let capturedQuery
    const deps = makeDeps({
      getDocumentsFn: async (query) => { capturedQuery = query; return { status: 200, result: [makeContract()] } },
    })
    await updatePCStatus('42', 'utlevering', undefined, deps)
    assert.equal(capturedQuery.pureserviceId, 42)
    assert.equal(typeof capturedQuery.pureserviceId, 'number')
  })

  test('throws with status 400 when studentId is not numeric', async () => {
    const deps = makeDeps()
    await assert.rejects(() => updatePCStatus('not-a-number', 'utlevering', undefined, deps), (err) => {
      assert.equal(err.status, 400)
      return true
    })
  })

  // --- Error cases ---
  test('throws with status 400 for unknown newStatus', async () => {
    const deps = makeDeps()
    await assert.rejects(() => updatePCStatus('123', 'ukjent', undefined, deps), (err) => {
      assert.equal(err.status, 400)
      return true
    })
  })

  test('throws with status 404 when studentId not found in either collection', async () => {
    const deps = makeDeps({ getDocumentsFn: async () => ({ status: 404, error: 'Fant ingen dokumenter' }) })
    await assert.rejects(() => updatePCStatus('123', 'utlevering', undefined, deps), (err) => {
      assert.equal(err.status, 404)
      return true
    })
  })

  test('returns result from updateContractPCStatus', async () => {
    const expected = { status: 200, acknowledged: true, modifiedCount: 1 }
    const deps = makeDeps({ updateContractPCStatusFn: async () => expected })
    const result = await updatePCStatus('123','innlevering', undefined, deps)
    assert.deepEqual(result, expected)
  })
})
