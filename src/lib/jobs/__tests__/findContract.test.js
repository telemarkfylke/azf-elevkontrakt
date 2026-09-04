'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { findContractById, assertContractUpdated, CONTRACT_DOCUMENT_TYPES } = require('../findContract.js')

const CONTRACT_ID = '507f1f77bcf86cd799439011'

/**
 * Fake getDocuments that answers 200 only for the named collection and records every lookup, so a
 * test can assert both the answer and that the search stopped where it should have.
 * @param {String|null} foundIn - documentType that holds the contract, or null for none
 * @param {Object} [overrides] - documentType -> canned result, for the non-200/non-404 cases
 */
const makeDeps = (foundIn, overrides = {}) => {
  const queries = []
  return {
    queries,
    deps: {
      getDocumentsFn: async (query, documentType) => {
        queries.push({ query, documentType })
        if (overrides[documentType]) return overrides[documentType]
        if (documentType === foundIn) return { status: 200, result: [{ _id: CONTRACT_ID, documentType }] }
        return { status: 404, error: 'Fant ingen dokumenter' }
      }
    }
  }
}

describe('findContractById', () => {
  test('searches regular, then pcIkkeInnlevert, then history', () => {
    assert.deepEqual(CONTRACT_DOCUMENT_TYPES, ['regular', 'pcIkkeInnlevert', 'history'])
  })

  test('finds a contract in kontrakter and stops there', async () => {
    const { queries, deps } = makeDeps('regular')
    const { contract, documentType } = await findContractById(CONTRACT_ID, deps)

    assert.equal(documentType, 'regular')
    assert.ok(contract)
    // Short-circuits: no point paying for two more round-trips in the common case
    assert.deepEqual(queries.map(q => q.documentType), ['regular'])
  })

  test('falls through to pcIkkeInnlevert - the case that motivated this helper', async () => {
    const { queries, deps } = makeDeps('pcIkkeInnlevert')
    const { documentType } = await findContractById(CONTRACT_ID, deps)

    assert.equal(documentType, 'pcIkkeInnlevert')
    assert.deepEqual(queries.map(q => q.documentType), ['regular', 'pcIkkeInnlevert'])
  })

  test('falls all the way through to history', async () => {
    const { queries, deps } = makeDeps('history')
    const { documentType } = await findContractById(CONTRACT_ID, deps)

    assert.equal(documentType, 'history')
    assert.deepEqual(queries.map(q => q.documentType), ['regular', 'pcIkkeInnlevert', 'history'])
  })

  test('queries by _id as an ObjectId', async () => {
    const { queries, deps } = makeDeps('regular')
    await findContractById(CONTRACT_ID, deps)

    assert.ok(queries[0].query._id instanceof ObjectId)
    assert.equal(String(queries[0].query._id), CONTRACT_ID)
  })

  test('accepts an ObjectId as well as a string', async () => {
    const { deps } = makeDeps('regular')
    const { documentType } = await findContractById(new ObjectId(CONTRACT_ID), deps)

    assert.equal(documentType, 'regular')
  })

  test('returns nulls when the contract is in no collection', async () => {
    const { queries, deps } = makeDeps(null)
    const result = await findContractById(CONTRACT_ID, deps)

    assert.deepEqual(result, { contract: null, documentType: null })
    assert.equal(queries.length, 3)
  })

  test('returns nulls without throwing on a malformed id', async () => {
    // new ObjectId('not-an-id') raises a BSONError. Callers rely on this returning instead: the
    // buyOut write-back has to carry on and still flip the invoice document, or the invoice is
    // re-sent to Xledger and the student is billed twice.
    const { queries, deps } = makeDeps('regular')
    const result = await findContractById('not-an-object-id', deps)

    assert.deepEqual(result, { contract: null, documentType: null })
    assert.equal(queries.length, 0, 'should not query at all with an invalid id')
  })

  test('returns nulls without throwing when no id is given', async () => {
    const { deps } = makeDeps('regular')
    assert.deepEqual(await findContractById(undefined, deps), { contract: null, documentType: null })
    assert.deepEqual(await findContractById(null, deps), { contract: null, documentType: null })
  })

  test('treats a non-200 non-404 status as a miss and keeps searching', async () => {
    // getDocuments answers 400 for an invalid documentType; that must not abort the search
    const { queries, deps } = makeDeps('history', { regular: { status: 400, error: 'Ugyldig documentType' } })
    const { documentType } = await findContractById(CONTRACT_ID, deps)

    assert.equal(documentType, 'history')
    assert.equal(queries.length, 3)
  })

  test('treats a 200 with an empty result array as a miss', async () => {
    const { deps } = makeDeps(null, { regular: { status: 200, result: [] } })
    const result = await findContractById(CONTRACT_ID, deps)

    assert.deepEqual(result, { contract: null, documentType: null })
  })
})

describe('assertContractUpdated', () => {
  test('accepts a normal Mongo update result', () => {
    assert.deepEqual(
      assertContractUpdated({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }, 'ctx'),
      { updated: true, reason: null }
    )
  })

  test('rejects matchedCount 0 - the silent no-op this whole change exists for', () => {
    const { updated, reason } = assertContractUpdated({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }, 'ctx')

    assert.equal(updated, false)
    assert.match(reason, /matchedCount 0/)
  })

  test('rejects an updateDocument error envelope', () => {
    const { updated, reason } = assertContractUpdated({ status: 400, error: 'Ugyldig documentType' }, 'ctx')

    assert.equal(updated, false)
    assert.equal(reason, 'Ugyldig documentType')
  })

  test('accepts a matched-but-unmodified update - the value was already correct', () => {
    const { updated } = assertContractUpdated({ acknowledged: true, matchedCount: 1, modifiedCount: 0 }, 'ctx')

    assert.equal(updated, true)
  })
})
