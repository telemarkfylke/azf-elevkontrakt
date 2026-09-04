'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { syncInvoiceCollectionSource, MOVE_TARGET_TO_DOCUMENT_TYPE } = require('../queryMongoDB.js')
const { invoiceQueryForContractIds } = require('../invoiceQueries.js')

const CONTRACT_ID = '507f1f77bcf86cd799439011'

/**
 * Minimal fake mongo client that records updateMany calls. Only the invoices collection is ever
 * touched by this function, so a single recorder is enough.
 */
const makeMongoClient = ({ throwOn = false, matchedCount = 2, modifiedCount = 2 } = {}) => {
  const updates = []
  return {
    updates,
    client: {
      db: () => ({
        collection: (name) => ({
          updateMany: async (filter, update) => {
            if (throwOn) throw new Error('mongo is down')
            updates.push({ collection: name, filter, update })
            return { matchedCount, modifiedCount }
          }
        })
      })
    }
  }
}

describe('invoiceQueryForContractIds', () => {
  const bothForms = (query) => ({
    objectIds: query.customerContractId.$in.filter(id => id instanceof ObjectId),
    strings: query.customerContractId.$in.filter(id => typeof id === 'string')
  })

  test('matches an ObjectId in both ObjectId and string form', () => {
    const { objectIds, strings } = bothForms(invoiceQueryForContractIds([new ObjectId(CONTRACT_ID)]))

    assert.equal(objectIds.length, 1)
    assert.equal(String(objectIds[0]), CONTRACT_ID)
    assert.deepEqual(strings, [CONTRACT_ID])
  })

  test('normalizes a plain string to an ObjectId too - getting this wrong fails OPEN', () => {
    // customerContractId is stored as an ObjectId, so a string-only $in matches nothing. That would
    // make the archive gate find no unsettled invoices and wave the contract through - the one
    // outcome it exists to prevent. handleDbRequest passes jsonBody.contractID as a string.
    const { objectIds, strings } = bothForms(invoiceQueryForContractIds([CONTRACT_ID]))

    assert.equal(objectIds.length, 1, 'a string id must still produce an ObjectId form')
    assert.equal(String(objectIds[0]), CONTRACT_ID)
    assert.deepEqual(strings, [CONTRACT_ID])
  })

  test('an ObjectId and its string are not duplicated', () => {
    const query = invoiceQueryForContractIds([new ObjectId(CONTRACT_ID), CONTRACT_ID])

    assert.equal(query.customerContractId.$in.length, 2)
  })

  test('handles several contracts at once, as the bulk gate does', () => {
    const other = '507f1f77bcf86cd799439099'
    const { objectIds, strings } = bothForms(invoiceQueryForContractIds([CONTRACT_ID, other]))

    assert.equal(objectIds.length, 2)
    assert.deepEqual(strings.sort(), [CONTRACT_ID, other].sort())
  })

  test('tolerates an id that is not a valid ObjectId', () => {
    const { objectIds, strings } = bothForms(invoiceQueryForContractIds(['not-an-object-id']))

    assert.equal(objectIds.length, 0)
    assert.deepEqual(strings, ['not-an-object-id'])
  })
})

describe('MOVE_TARGET_TO_DOCUMENT_TYPE', () => {
  test('maps the contract-bearing targets and deliberately omits deleted/duplicates', () => {
    assert.deepEqual(MOVE_TARGET_TO_DOCUMENT_TYPE, {
      contracts: 'regular',
      regular: 'regular',
      pcIkkeInnlevert: 'pcIkkeInnlevert',
      historic: 'history'
    })
    assert.equal(MOVE_TARGET_TO_DOCUMENT_TYPE.deleted, undefined)
    assert.equal(MOVE_TARGET_TO_DOCUMENT_TYPE.duplicates, undefined)
  })
})

describe('syncInvoiceCollectionSource', () => {
  test("repoints invoices to 'history' on an archive move", async () => {
    const { updates, client } = makeMongoClient()
    const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'historic', { getMongoClientFn: async () => client })

    assert.deepEqual(result, { matched: 2, modified: 2 })
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].update, { $set: { mainDocumentCollectionSource: 'history' } })
  })

  test("repoints invoices to 'pcIkkeInnlevert' - the common real-world move", async () => {
    const { updates, client } = makeMongoClient()
    await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'pcIkkeInnlevert', { getMongoClientFn: async () => client })

    assert.deepEqual(updates[0].update, { $set: { mainDocumentCollectionSource: 'pcIkkeInnlevert' } })
  })

  test("maps both 'contracts' and 'regular' back to 'regular'", async () => {
    for (const target of ['contracts', 'regular']) {
      const { updates, client } = makeMongoClient()
      await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), target, { getMongoClientFn: async () => client })
      assert.deepEqual(updates[0].update, { $set: { mainDocumentCollectionSource: 'regular' } })
    }
  })

  test('updates every invoice for the contract, not just one', async () => {
    const { updates, client } = makeMongoClient({ matchedCount: 3, modifiedCount: 3 })
    const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'historic', { getMongoClientFn: async () => client })

    // A contract legitimately has several invoices (multiple buyOut rates plus extraInvoices)
    assert.equal(result.matched, 3)
    assert.ok(updates[0].filter.customerContractId.$in)
  })

  test('matches customerContractId in both ObjectId and string form', async () => {
    const { updates, client } = makeMongoClient()
    await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'historic', { getMongoClientFn: async () => client })

    const ids = updates[0].filter.customerContractId.$in
    assert.equal(ids.length, 2)
    assert.ok(ids.some(id => id instanceof ObjectId))
    assert.ok(ids.some(id => id === CONTRACT_ID))
  })

  test('leaves the pointer alone for deleted and duplicates', async () => {
    // Neither collection is reachable by any contract lookup, so there is no valid value to write -
    // writing one would only turn a stale pointer into a permanently unresolvable one.
    for (const target of ['deleted', 'duplicates']) {
      const { updates, client } = makeMongoClient()
      const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), target, { getMongoClientFn: async () => client })

      assert.equal(result.skipped, true)
      assert.equal(updates.length, 0, `should not write for target '${target}'`)
    }
  })

  test('skips and logs rather than guessing on an unrecognised target', async () => {
    const { updates, client } = makeMongoClient()
    const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'nonsense', { getMongoClientFn: async () => client })

    assert.equal(result.skipped, true)
    assert.equal(updates.length, 0)
  })

  test('never throws - a failure here must not fail an already-committed move', async () => {
    const { client } = makeMongoClient({ throwOn: true })
    const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'historic', { getMongoClientFn: async () => client })

    assert.ok(result.error, 'should report the error rather than raise it')
    assert.equal(result.error, 'mongo is down')
  })

  test('never throws when the client itself cannot be obtained', async () => {
    const result = await syncInvoiceCollectionSource(new ObjectId(CONTRACT_ID), 'historic', {
      getMongoClientFn: async () => { throw new Error('no connection') }
    })

    assert.equal(result.error, 'no connection')
  })
})
