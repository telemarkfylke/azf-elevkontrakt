'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { updateImportedBuyOutDocument } = require('../serverJobs/xledgerInvoiceImport.js')

const CONTRACT_ID = '507f1f77bcf86cd799439011'
const INVOICE_ID = '507f1f77bcf86cd799439022'
const ORDER_NO = 'JOT-000000001-2-2025-ptc9lm'

const makeInvoice = (overrides = {}) => ({
  _id: INVOICE_ID,
  type: 'buyOut',
  customerContractId: CONTRACT_ID,
  // The stale value: the contract was in kontrakter when the invoice was created
  mainDocumentCollectionSource: 'regular',
  status: 'Ikke Fakturert',
  itemsFromCart: [{ faktureringsår: '2025', sum: 2500 }],
  rates: [{ faktureringsår: '2025', status: 'Fakturert - Utkjøp', løpenummer: ORDER_NO }],
  ...overrides
})

const UPDATE_DATA = {
  'fakturaInfo.rate2.status': 'Fakturert',
  'fakturaInfo.rate2.faktureringsDato': '2026-09-03T00:00:00.000Z',
  'fakturaInfo.rate2.løpenummer': ORDER_NO,
  'fakturaInfo.rate2.sum': 2500
}

/**
 * Records every updateDocument call so each test can assert on the two writes independently: the
 * contract write (which may legitimately fail) and the invoice write (which must always happen).
 * @param {String|null} foundIn - what findContractById resolves to
 */
const makeDeps = ({ foundIn = 'pcIkkeInnlevert', updateResult = { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, contractWriteThrows = false } = {}) => {
  const updates = []
  return {
    updates,
    invoiceWrites: () => updates.filter(u => u.documentType === 'invoices'),
    contractWrites: () => updates.filter(u => u.documentType !== 'invoices'),
    deps: {
      findContractByIdFn: async () => ({ contract: foundIn ? { _id: CONTRACT_ID } : null, documentType: foundIn }),
      updateDocumentFn: async (documentId, updateData, documentType) => {
        if (contractWriteThrows && documentType !== 'invoices') throw new Error('mongo blew up')
        updates.push({ documentId, updateData, documentType })
        return documentType === 'invoices' ? { acknowledged: true, matchedCount: 1, modifiedCount: 1 } : updateResult
      },
      logger: () => {}
    }
  }
}

describe('updateImportedBuyOutDocument - the happy path', () => {
  test('resolves the contract from the database, ignoring the stale stored pointer', async () => {
    // The invoice says 'regular'; the contract is actually in pcIkkeInnlevert. Before this change
    // the write went to kontrakter, matched nothing, and reported success.
    const { contractWrites, deps } = makeDeps({ foundIn: 'pcIkkeInnlevert' })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.contractUpdated, true)
    assert.equal(result.failure, null)
    assert.equal(contractWrites().length, 1)
    assert.equal(contractWrites()[0].documentType, 'pcIkkeInnlevert')
    assert.notEqual(contractWrites()[0].documentType, 'regular')
  })

  test("preserves the buyOut-specific 'Fakturert - Utkjøp' contract status", async () => {
    const { contractWrites, deps } = makeDeps()
    await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(contractWrites()[0].updateData['fakturaInfo.rate2.status'], 'Fakturert - Utkjøp')
    assert.equal(contractWrites()[0].updateData['fakturaInfo.rate2.løpenummer'], ORDER_NO)
    assert.equal(contractWrites()[0].updateData['fakturaInfo.rate2.sum'], 2500)
  })

  test('flips the invoice document and its matching rate to Fakturert', async () => {
    const { invoiceWrites, deps } = makeDeps()
    await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(invoiceWrites().length, 1)
    assert.equal(invoiceWrites()[0].updateData.status, 'Fakturert')
    assert.equal(invoiceWrites()[0].updateData['rates.0.status'], 'Fakturert')
    assert.equal(invoiceWrites()[0].updateData['itemsFromCart.0.løpenummer'], ORDER_NO)
  })

  test('writes to a contract in kontrakter when that is where it still is', async () => {
    const { contractWrites, deps } = makeDeps({ foundIn: 'regular' })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.contractUpdated, true)
    assert.equal(contractWrites()[0].documentType, 'regular')
  })
})

// The invoice write is the double-invoicing guard: xledgerExtraInvoice selects candidates on
// status 'Ikke Fakturert', so an invoice left unflipped is re-sent to Xledger on the next run.
// Every failure mode below must still reach it.
describe('updateImportedBuyOutDocument - the invoice write always happens', () => {
  test('when the contract is in no collection at all', async () => {
    const { invoiceWrites, contractWrites, deps } = makeDeps({ foundIn: null })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.invoiceUpdated, true)
    assert.equal(invoiceWrites().length, 1, 'invoice MUST still be marked Fakturert')
    assert.equal(contractWrites().length, 0)
    assert.equal(result.contractUpdated, false)
    assert.equal(result.failure.documentType, null)
    assert.match(result.failure.reason, /Fant ingen kontrakt/)
  })

  test('when the contract sits in historiske-avtaler, which is not writable', async () => {
    const { invoiceWrites, contractWrites, deps } = makeDeps({ foundIn: 'history' })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.invoiceUpdated, true)
    assert.equal(invoiceWrites().length, 1, 'invoice MUST still be marked Fakturert')
    assert.equal(contractWrites().length, 0, 'the final archive must not be written to')
    assert.equal(result.contractUpdated, false)
    assert.equal(result.failure.documentType, 'history')
    assert.match(result.failure.reason, /historiske-avtaler/)
  })

  test('when the contract write matches nothing (matchedCount 0)', async () => {
    const { invoiceWrites, deps } = makeDeps({ updateResult: { acknowledged: true, matchedCount: 0, modifiedCount: 0 } })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.invoiceUpdated, true)
    assert.equal(invoiceWrites().length, 1, 'invoice MUST still be marked Fakturert')
    assert.equal(result.contractUpdated, false)
    assert.match(result.failure.reason, /matchedCount 0/)
  })

  test('when the contract write throws outright', async () => {
    const { invoiceWrites, deps } = makeDeps({ contractWriteThrows: true })
    const result = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.invoiceUpdated, true)
    assert.equal(invoiceWrites().length, 1, 'invoice MUST still be marked Fakturert')
    assert.equal(result.contractUpdated, false)
    assert.match(result.failure.reason, /mongo blew up/)
  })
})

describe('updateImportedBuyOutDocument - reporting', () => {
  test('a failure carries everything an operator needs to fix it by hand', async () => {
    const { deps } = makeDeps({ foundIn: 'history' })
    const { failure } = await updateImportedBuyOutDocument(makeInvoice(), ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(failure.invoiceId, INVOICE_ID)
    assert.equal(failure.customerContractId, CONTRACT_ID)
    assert.equal(failure.løpenummer, ORDER_NO)
    assert.equal(failure.rateNumber, 2)
    // The exact $set that was refused, so it can be replayed once the contract is moved back out
    assert.equal(failure.refusedUpdate['fakturaInfo.rate2.status'], 'Fakturert - Utkjøp')
  })

  test('skips both writes when the rate is missing from the invoice', async () => {
    // Nothing to write back against, so there is no partial update to leave behind
    const { updates, deps } = makeDeps()
    const invoice = makeInvoice({ rates: [{ faktureringsår: '2025', status: 'Ikke Fakturert', løpenummer: 'SOME-OTHER-ORDER' }] })
    const result = await updateImportedBuyOutDocument(invoice, ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(result.contractUpdated, false)
    assert.equal(result.invoiceUpdated, false)
    assert.equal(updates.length, 0)
    assert.match(result.failure.reason, /Fant ingen rate/)
  })

  test('targets the right rate index when the invoice has several rates', async () => {
    const { invoiceWrites, deps } = makeDeps()
    const invoice = makeInvoice({
      rates: [
        { faktureringsår: '2024', status: 'Betalt', løpenummer: 'JOT-000000001-1-2024-aaaaaa' },
        { faktureringsår: '2025', status: 'Fakturert - Utkjøp', løpenummer: ORDER_NO }
      ]
    })
    await updateImportedBuyOutDocument(invoice, ORDER_NO, 2, UPDATE_DATA, deps)

    assert.equal(invoiceWrites()[0].updateData['rates.1.status'], 'Fakturert')
    assert.equal(invoiceWrites()[0].updateData['rates.0.status'], undefined, 'must not touch the already-paid rate')
  })
})
