'use strict'

/**
 * moveAndDeleteDocument is the chokepoint every contract move goes through, and had no direct
 * coverage at all - the archiveResolvedPcIkkeInnlevert tests inject a fake in its place. These
 * exercise the real function, in particular the invoice-pointer sync bolted onto the end of it and
 * the ObjectId normalization that sync depends on.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { moveAndDeleteDocument } = require('../queryMongoDB.js')

const CONTRACT_ID = '507f1f77bcf86cd799439011'

/**
 * Records every collection operation. deletedCount/acknowledged are configurable so the
 * partial-move case (insert succeeded, delete did not) can be reproduced.
 */
const makeDeps = ({ docToMove = { pureserviceId: 42 }, deletedCount = 1, acknowledged = true, patchUserThrows = false, syncResult = { matched: 2, modified: 2 } } = {}) => {
  const ops = []
  const syncCalls = []
  const patchUserCalls = []
  return {
    ops,
    syncCalls,
    patchUserCalls,
    deps: {
      getMongoClientFn: async () => ({
        db: () => ({
          listCollections: () => ({ hasNext: async () => true }),
          collection: (name) => ({
            findOne: async (query) => {
              ops.push({ op: 'findOne', name, query })
              return docToMove === null ? null : { _id: query._id, ...docToMove }
            },
            insertOne: async (doc) => {
              ops.push({ op: 'insertOne', name, doc })
              return { acknowledged }
            },
            deleteOne: async (query) => {
              ops.push({ op: 'deleteOne', name, query })
              return { deletedCount }
            }
          })
        })
      }),
      patchUserFn: async (id, body) => {
        patchUserCalls.push({ id, body })
        if (patchUserThrows) throw new Error('pureservice down')
      },
      syncInvoiceCollectionSourceFn: async (contractObjectId, targetCollection) => {
        syncCalls.push({ contractObjectId, targetCollection })
        return syncResult
      }
    }
  }
}

describe('moveAndDeleteDocument - validation', () => {
  test('rejects a missing documentId', async () => {
    const { deps } = makeDeps()
    assert.equal((await moveAndDeleteDocument(null, 'historic', 'regular', deps)).status, 400)
  })

  test('rejects a malformed documentId instead of throwing a BSONError', async () => {
    const { ops, deps } = makeDeps()
    const result = await moveAndDeleteDocument('not-an-object-id', 'historic', 'regular', deps)

    assert.equal(result.status, 400)
    assert.match(result.error, /Ugyldig documentId/)
    assert.equal(ops.length, 0, 'must not touch the database with an invalid id')
  })

  test('rejects a missing targetCollection or sourceCollection', async () => {
    const { deps } = makeDeps()
    assert.equal((await moveAndDeleteDocument(CONTRACT_ID, null, 'regular', deps)).status, 400)
    assert.equal((await moveAndDeleteDocument(CONTRACT_ID, 'historic', null, deps)).status, 400)
  })
})

describe('moveAndDeleteDocument - the move itself', () => {
  test('preserves _id across the move, which is what keeps invoices linked', async () => {
    const { ops, deps } = makeDeps()
    await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    const insert = ops.find(op => op.op === 'insertOne')
    assert.equal(String(insert.doc._id), CONTRACT_ID)
  })

  test('queries and deletes by the same normalized ObjectId', async () => {
    const { ops, deps } = makeDeps()
    await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    for (const op of ops.filter(o => o.query)) {
      assert.ok(op.query._id instanceof ObjectId, `${op.op} should query by ObjectId`)
      assert.equal(String(op.query._id), CONTRACT_ID)
    }
  })

  test('returns 404 when the document is not in the source collection', async () => {
    const { deps, syncCalls } = makeDeps({ docToMove: null })
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.equal(result.status, 404)
    assert.equal(syncCalls.length, 0)
  })

  test("resets cf_2 in Pureservice and drops pureserviceId on the way to 'historic'", async () => {
    const { ops, patchUserCalls, deps } = makeDeps()
    await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.deepEqual(patchUserCalls, [{ id: 42, body: { cf_2: '' } }])
    assert.equal(ops.find(op => op.op === 'insertOne').doc.pureserviceId, undefined)
  })

  test('aborts the whole move with a 502 when the Pureservice reset fails', async () => {
    // The document must be left in place for the next run, not archived with a stale link
    const { ops, deps, syncCalls } = makeDeps({ patchUserThrows: true })
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.equal(result.status, 502)
    assert.equal(ops.filter(op => op.op === 'insertOne').length, 0)
    assert.equal(ops.filter(op => op.op === 'deleteOne').length, 0)
    assert.equal(syncCalls.length, 0)
  })

  test('does not touch Pureservice for a non-historic target', async () => {
    const { patchUserCalls, deps } = makeDeps()
    await moveAndDeleteDocument(CONTRACT_ID, 'pcIkkeInnlevert', 'regular', deps)

    assert.equal(patchUserCalls.length, 0)
  })
})

describe('moveAndDeleteDocument - invoice pointer sync', () => {
  test('syncs the pointer once both halves of the move succeed', async () => {
    const { syncCalls, deps } = makeDeps()
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'pcIkkeInnlevert', 'regular', deps)

    assert.equal(result.status, 200)
    assert.equal(syncCalls.length, 1)
    assert.equal(syncCalls[0].targetCollection, 'pcIkkeInnlevert')
    assert.deepEqual(result.invoiceSourceSync, { matched: 2, modified: 2 })
  })

  test('hands the sync an ObjectId even when given a string id', async () => {
    // handleDbRequest passes jsonBody.contractID off the wire; customerContractId is stored as an
    // ObjectId, so a string reaching the $in unconverted would match no invoices at all
    const { syncCalls, deps } = makeDeps()
    await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.ok(syncCalls[0].contractObjectId instanceof ObjectId)
    assert.equal(String(syncCalls[0].contractObjectId), CONTRACT_ID)
  })

  test('skips the sync for a mock move so test data cannot rewrite real invoices', async () => {
    const { syncCalls, deps } = makeDeps()
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'deleted', 'mock', deps)

    assert.equal(result.status, 200)
    assert.equal(syncCalls.length, 0)
    assert.deepEqual(result.invoiceSourceSync, { skipped: true, reason: 'mock' })
  })

  test('skips the sync on a partial move, leaving the source copy authoritative', async () => {
    // Insert succeeded, delete did not: the document is in both collections, so the pointer at the
    // source is not yet wrong and must not be moved on
    const { syncCalls, deps } = makeDeps({ deletedCount: 0 })
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.equal(result.status, 404)
    assert.equal(syncCalls.length, 0)
  })

  test('still reports success when the sync fails - a committed move is never undone', async () => {
    const { deps } = makeDeps({ syncResult: { error: 'mongo is down' } })
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.equal(result.status, 200, 'a stale pointer is recoverable; a half-undone move is not')
    assert.equal(result.invoiceSourceSync.error, 'mongo is down')
  })

  test('does not sync when the insert was not acknowledged', async () => {
    const { syncCalls, deps } = makeDeps({ acknowledged: false })
    const result = await moveAndDeleteDocument(CONTRACT_ID, 'historic', 'regular', deps)

    assert.equal(result.status, 500)
    assert.equal(syncCalls.length, 0)
  })
})
