'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { repairInvoiceCollectionSource } = require('../serverJobs/miscCleanUpJobs.js')

const makeInvoice = (id, mainDocumentCollectionSource, overrides = {}) => ({
  _id: id,
  type: 'buyOut',
  customerContractId: `contract-${id}`,
  mainDocumentCollectionSource,
  ...overrides
})

/**
 * @param {Array} invoices - what the invoices collection holds
 * @param {Object} resolveMap - customerContractId -> documentType the contract actually lives in
 */
const makeDeps = (invoices, resolveMap, { probeResult = null } = {}) => {
  const writes = []
  return {
    writes,
    deps: {
      getDocumentsFn: async (query, documentType) => {
        if (documentType !== 'invoices') throw new Error(`unexpected read of '${documentType}'`)
        if (invoices.length === 0) return { status: 404, error: 'Fant ingen dokumenter' }
        return { status: 200, result: invoices }
      },
      updateDocumentFn: async (documentId, updateData, documentType) => {
        writes.push({ documentId, updateData, documentType })
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
      findContractByIdFn: async (contractId) => ({
        contract: resolveMap[contractId] ? {} : null,
        documentType: resolveMap[contractId] ?? null
      }),
      probeDuplicatesAndDeletedFn: async () => probeResult
    }
  }
}

describe('repairInvoiceCollectionSource', () => {
  test('defaults to a dry run and writes nothing', async () => {
    const invoices = [makeInvoice('inv-1', 'regular')]
    const { writes, deps } = makeDeps(invoices, { 'contract-inv-1': 'pcIkkeInnlevert' })

    const report = await repairInvoiceCollectionSource(undefined, deps)

    assert.equal(report.dryRun, true)
    assert.equal(writes.length, 0, 'a dry run must not write')
    assert.equal(report.repaired.length, 1)
    assert.equal(report.repaired[0].repaired, false)
  })

  test('reports the stored and resolved values, which is the whole explanation', async () => {
    const invoices = [makeInvoice('inv-1', 'regular')]
    const { deps } = makeDeps(invoices, { 'contract-inv-1': 'pcIkkeInnlevert' })

    const report = await repairInvoiceCollectionSource(true, deps)

    assert.equal(report.repaired[0].invoiceId, 'inv-1')
    assert.equal(report.repaired[0].type, 'buyOut')
    assert.equal(report.repaired[0].from, 'regular')
    assert.equal(report.repaired[0].to, 'pcIkkeInnlevert')
  })

  test('repairs only the drifted invoices when actually run', async () => {
    const invoices = [
      makeInvoice('inv-drifted', 'regular'),
      makeInvoice('inv-correct', 'pcIkkeInnlevert'),
      makeInvoice('inv-also-correct', 'regular')
    ]
    const { writes, deps } = makeDeps(invoices, {
      'contract-inv-drifted': 'pcIkkeInnlevert',
      'contract-inv-correct': 'pcIkkeInnlevert',
      'contract-inv-also-correct': 'regular'
    })

    const report = await repairInvoiceCollectionSource(false, deps)

    assert.equal(writes.length, 1, 'idempotent: only the drifted one is written')
    assert.equal(writes[0].documentId, 'inv-drifted')
    assert.deepEqual(writes[0].updateData, { mainDocumentCollectionSource: 'pcIkkeInnlevert' })
    assert.equal(writes[0].documentType, 'invoices')
    assert.equal(report.alreadyCorrect, 2)
    assert.equal(report.repaired.length, 1)
    assert.equal(report.repaired[0].repaired, true)
  })

  test("repoints an invoice whose contract reached the final archive to 'history'", async () => {
    const invoices = [makeInvoice('inv-1', 'regular')]
    const { writes, deps } = makeDeps(invoices, { 'contract-inv-1': 'history' })

    await repairInvoiceCollectionSource(false, deps)

    assert.deepEqual(writes[0].updateData, { mainDocumentCollectionSource: 'history' })
  })

  test('reports an unresolvable invoice without clearing its pointer', async () => {
    // The stored value is the only remaining record of where the contract used to be
    const invoices = [makeInvoice('inv-orphan', 'regular')]
    const { writes, deps } = makeDeps(invoices, {})

    const report = await repairInvoiceCollectionSource(false, deps)

    assert.equal(writes.length, 0, 'must not write to an invoice whose contract cannot be found')
    assert.equal(report.unresolvable.length, 1)
    assert.equal(report.unresolvable[0].invoiceId, 'inv-orphan')
    assert.equal(report.unresolvable[0].from, 'regular')
    assert.equal(report.repaired.length, 0)
  })

  test('explains an unresolvable invoice when the contract is in duplicates or deleted', async () => {
    // getDocuments exposes no branch for either, so findContractById can never resolve these -
    // the probe is what stops it being a permanently unexplained report entry
    const invoices = [makeInvoice('inv-orphan', 'regular')]
    const { deps } = makeDeps(invoices, {}, { probeResult: 'duplicates' })

    const report = await repairInvoiceCollectionSource(true, deps)

    assert.equal(report.unresolvable[0].foundIn, 'duplicates')
  })

  test('flags an invoice with no pointer at all', async () => {
    // Used to be indistinguishable from a genuine miss: getDocuments(query, undefined) answers 400,
    // which the old code reported as "contract not found"
    const invoices = [makeInvoice('inv-nofield', undefined)]
    const { writes, deps } = makeDeps(invoices, { 'contract-inv-nofield': 'regular' })

    const report = await repairInvoiceCollectionSource(false, deps)

    assert.equal(report.missingField.length, 1)
    assert.equal(report.missingField[0].invoiceId, 'inv-nofield')
    assert.equal(report.missingField[0].from, null)
    // Still repaired - a missing pointer is drift too
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].updateData, { mainDocumentCollectionSource: 'regular' })
  })

  test('covers extraInvoice as well as buyOut', async () => {
    const invoices = [
      makeInvoice('inv-buyout', 'regular'),
      makeInvoice('inv-extra', 'regular', { type: 'extraInvoice', rates: [] })
    ]
    const { writes, deps } = makeDeps(invoices, {
      'contract-inv-buyout': 'pcIkkeInnlevert',
      'contract-inv-extra': 'pcIkkeInnlevert'
    })

    const report = await repairInvoiceCollectionSource(false, deps)

    assert.equal(writes.length, 2)
    assert.deepEqual(report.repaired.map(entry => entry.type).sort(), ['buyOut', 'extraInvoice'])
  })

  test('handles an empty invoices collection', async () => {
    const { writes, deps } = makeDeps([], {})

    const report = await repairInvoiceCollectionSource(false, deps)

    assert.equal(report.total, 0)
    assert.equal(writes.length, 0)
    assert.deepEqual(report.repaired, [])
  })
})
