'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const {
  isInvoiceSettled,
  describeInvoice,
  fetchInvoicesByContract,
  getUnsettledInvoices,
  SETTLED_INVOICE_STATUSES
} = require('../invoiceChecks.js')

// ---- Helpers ---------------------------------------------------------------

const makeInvoice = (overrides = {}) => ({
  _id: 'invoice-1',
  customerContractId: 'doc-1',
  type: 'extraInvoice',
  status: 'Betalt',
  rates: [],
  ...overrides
})

/**
 * Records every read so tests can assert the query shape and the number of round-trips.
 * @param invoices - documents to answer with, or null/[] to answer 404 like getDocuments does
 */
const makeReader = (invoices) => {
  const queries = []
  const getDocumentsFn = async (query, documentType) => {
    queries.push({ query, documentType })
    if (!invoices || invoices.length === 0) return { status: 404, error: 'Fant ingen dokumenter' }
    return { status: 200, result: invoices }
  }
  return { queries, getDocumentsFn }
}

// =====================================================================
// isInvoiceSettled - top-level status AND every rate
// =====================================================================

describe('isInvoiceSettled', () => {
  test('true for a Betalt extraInvoice with no rates', () => {
    assert.equal(isInvoiceSettled(makeInvoice({ status: 'Betalt' })), true)
  })

  test('true for a Kreditert invoice', () => {
    assert.equal(isInvoiceSettled(makeInvoice({ status: 'Kreditert' })), true)
  })

  test('false for an unbilled invoice', () => {
    assert.equal(isInvoiceSettled(makeInvoice({ status: 'Ikke Fakturert' })), false)
  })

  // TERMINAL_STATUSES in repairBuyOutInvoiceStatuses counts inkasso as terminal; settled it is not
  test('false for an invoice in "Overført inkasso"', () => {
    assert.equal(isInvoiceSettled(makeInvoice({ status: 'Overført inkasso' })), false)
  })

  test('false when the top-level status is stale but a rate is not settled', () => {
    const invoice = makeInvoice({ type: 'buyOut', status: 'Betalt', rates: [{ status: 'Betalt' }, { status: 'Fakturert' }] })
    assert.equal(isInvoiceSettled(invoice), false)
  })

  test('true when both the top-level status and every rate are settled', () => {
    const invoice = makeInvoice({ type: 'buyOut', status: 'Betalt', rates: [{ status: 'Betalt' }, { status: 'Kreditert' }] })
    assert.equal(isInvoiceSettled(invoice), true)
  })

  test('tolerates a missing rates array', () => {
    assert.equal(isInvoiceSettled({ status: 'Betalt' }), true)
  })

  test('accepts exactly Betalt and Kreditert', () => {
    assert.deepEqual(SETTLED_INVOICE_STATUSES, ['Betalt', 'Kreditert'])
  })
})

// =====================================================================
// describeInvoice
// =====================================================================

describe('describeInvoice', () => {
  test('reduces an invoice to the reportable fields', () => {
    const invoice = makeInvoice({ _id: 'invoice-9', type: 'buyOut', status: 'Fakturert', rates: [{ status: 'Fakturert' }] })
    assert.deepEqual(describeInvoice(invoice), {
      invoiceId: 'invoice-9',
      type: 'buyOut',
      status: 'Fakturert',
      rateStatuses: ['Fakturert']
    })
  })

  test('tolerates a missing rates array', () => {
    assert.deepEqual(describeInvoice({ _id: 'invoice-9', type: 'extraInvoice', status: 'Betalt' }).rateStatuses, [])
  })
})

// =====================================================================
// fetchInvoicesByContract - bulk, one round-trip
// =====================================================================

describe('fetchInvoicesByContract', () => {
  test('groups invoices by contract id', async () => {
    const invoices = [
      makeInvoice({ _id: 'invoice-a', customerContractId: 'doc-1' }),
      makeInvoice({ _id: 'invoice-b', customerContractId: 'doc-1' }),
      makeInvoice({ _id: 'invoice-c', customerContractId: 'doc-2' })
    ]
    const { getDocumentsFn } = makeReader(invoices)
    const grouped = await fetchInvoicesByContract([{ _id: 'doc-1' }, { _id: 'doc-2' }], getDocumentsFn)

    assert.deepEqual([...grouped.keys()], ['doc-1', 'doc-2'])
    assert.deepEqual(grouped.get('doc-1').map(invoice => invoice._id), ['invoice-a', 'invoice-b'])
    assert.deepEqual(grouped.get('doc-2').map(invoice => invoice._id), ['invoice-c'])
  })

  test('reads the invoices collection once, querying both id forms', async () => {
    // Real ObjectIds, since the point of the two forms is that a stored ObjectId and a legacy
    // string-valued customerContractId are both matched
    const first = new ObjectId('507f1f77bcf86cd799439011')
    const second = new ObjectId('507f1f77bcf86cd799439022')
    const { getDocumentsFn, queries } = makeReader([makeInvoice()])
    await fetchInvoicesByContract([{ _id: first }, { _id: second }], getDocumentsFn)

    assert.equal(queries.length, 1)
    assert.equal(queries[0].documentType, 'invoices')
    const ids = queries[0].query.customerContractId.$in
    for (const id of [first, second]) {
      assert.ok(ids.some(candidate => candidate instanceof ObjectId && candidate.equals(id)), `missing ObjectId form of ${id}`)
      assert.ok(ids.includes(String(id)), `missing string form of ${id}`)
    }
  })

  test('returns an empty map when getDocuments answers 404', async () => {
    const { getDocumentsFn } = makeReader(null)
    const grouped = await fetchInvoicesByContract([{ _id: 'doc-1' }], getDocumentsFn)

    assert.equal(grouped.size, 0)
  })

  test('does not query at all for an empty contract list', async () => {
    const { getDocumentsFn, queries } = makeReader([makeInvoice()])
    const grouped = await fetchInvoicesByContract([], getDocumentsFn)

    assert.equal(queries.length, 0)
    assert.equal(grouped.size, 0)
  })

  test('keys on String(_id) so an ObjectId-valued customerContractId still matches', async () => {
    // Mongo hands back an ObjectId here, not a string
    const objectId = { toString: () => 'doc-oid' }
    const { getDocumentsFn } = makeReader([makeInvoice({ customerContractId: objectId })])
    const grouped = await fetchInvoicesByContract([{ _id: objectId }], getDocumentsFn)

    assert.deepEqual(grouped.get('doc-oid').length, 1)
  })
})

// =====================================================================
// getUnsettledInvoices - single contract
// =====================================================================

describe('getUnsettledInvoices', () => {
  test('returns only the unsettled invoices from a mixed set', async () => {
    const invoices = [
      makeInvoice({ _id: 'invoice-paid', status: 'Betalt' }),
      makeInvoice({ _id: 'invoice-unpaid', status: 'Ikke Fakturert' }),
      makeInvoice({ _id: 'invoice-inkasso', status: 'Overført inkasso' })
    ]
    const { getDocumentsFn } = makeReader(invoices)
    const unsettled = await getUnsettledInvoices('doc-1', { getDocumentsFn })

    assert.deepEqual(unsettled.map(invoice => invoice._id), ['invoice-unpaid', 'invoice-inkasso'])
  })

  test('returns an empty array when every invoice is settled', async () => {
    const invoices = [
      makeInvoice({ status: 'Betalt' }),
      makeInvoice({ _id: 'invoice-b', status: 'Kreditert' })
    ]
    const { getDocumentsFn } = makeReader(invoices)

    assert.deepEqual(await getUnsettledInvoices('doc-1', { getDocumentsFn }), [])
  })

  test('returns an empty array when the contract has no invoices (404)', async () => {
    const { getDocumentsFn } = makeReader(null)

    assert.deepEqual(await getUnsettledInvoices('doc-1', { getDocumentsFn }), [])
  })

  test('queries both id forms even when handed a plain string', async () => {
    // handleDbRequest's DELETE gate passes jsonBody.contractID, a string off the wire, while the
    // jobs pass an ObjectId. If the string were not normalized the $in would match no stored
    // ObjectId at all - the gate would find nothing unsettled and wave the contract through.
    const contractId = '507f1f77bcf86cd799439011'
    const { getDocumentsFn, queries } = makeReader([makeInvoice()])
    await getUnsettledInvoices(contractId, { getDocumentsFn })

    assert.equal(queries.length, 1)
    assert.equal(queries[0].documentType, 'invoices')
    const ids = queries[0].query.customerContractId.$in
    assert.ok(ids.some(id => id instanceof ObjectId && id.equals(new ObjectId(contractId))), 'missing ObjectId form')
    assert.ok(ids.includes(contractId), 'missing string form')
  })

  test('catches a buyOut whose top-level status is settled but a rate is not', async () => {
    const invoice = makeInvoice({ type: 'buyOut', status: 'Betalt', rates: [{ status: 'Fakturert' }] })
    const { getDocumentsFn } = makeReader([invoice])

    assert.equal((await getUnsettledInvoices('doc-1', { getDocumentsFn })).length, 1)
  })
})
