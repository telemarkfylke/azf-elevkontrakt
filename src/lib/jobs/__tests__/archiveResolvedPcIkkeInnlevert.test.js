'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { archiveResolvedPcIkkeInnlevert, isDecidable, CANDIDATE_QUERY } = require('../archiveResolvedPcIkkeInnlevert.js')

// ---- Helpers ---------------------------------------------------------------

const makeDoc = (overrides = {}) => ({
  _id: 'doc-1',
  elevInfo: { navn: 'Test Elev' },
  unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
  pcInfo: { returned: 'true' },
  fakturaInfo: {
    rate1: { status: 'Betalt' },
    rate2: { status: 'Betalt' },
    rate3: { status: 'Betalt' }
  },
  ...overrides
})

const rates = (...statuses) => ({
  rate1: { status: statuses[0] },
  rate2: { status: statuses[1] },
  rate3: { status: statuses[2] }
})

const makeInvoice = (overrides = {}) => ({
  _id: 'invoice-1',
  customerContractId: 'doc-1',
  type: 'extraInvoice',
  status: 'Betalt',
  rates: [],
  ...overrides
})

/**
 * Builds deps that record every move call and route reads by collection. postTeamsReportFn is
 * always stubbed so no test can reach the real axios webhook post.
 * @param documents - contracts in pcIkkeInnlevert, or null to make that read answer 404
 * @param invoices - documents in the invoices collection (default: none, so the gate is a no-op)
 */
const makeDeps = (documents, { moveResult = { status: 200 }, invoices = [] } = {}) => {
  const moveCalls = []
  const teamsReports = []
  const queries = []
  return {
    moveCalls,
    teamsReports,
    queries,
    invoiceQueries: () => queries.filter(entry => entry.documentType === 'invoices'),
    deps: {
      getDocumentsFn: async (query, documentType) => {
        queries.push({ query, documentType })
        const result = documentType === 'invoices' ? invoices : documents
        if (result === null || result.length === 0) return { status: 404, error: 'Fant ingen dokumenter' }
        return { status: 200, result }
      },
      moveAndDeleteDocumentFn: async (documentId, targetCollection, sourceCollection) => {
        moveCalls.push({ documentId, targetCollection, sourceCollection })
        return typeof moveResult === 'function' ? moveResult(documentId) : moveResult
      },
      postTeamsReportFn: async (report) => { teamsReports.push(report) }
    }
  }
}

// =====================================================================
// isDecidable - guards determineHistoryMoveTarget's unguarded dereferences
// =====================================================================

describe('isDecidable', () => {
  test('true for a document with pcInfo and all three rate statuses', () => {
    assert.equal(isDecidable(makeDoc()), true)
  })

  test('false when fakturaInfo is missing entirely', () => {
    assert.equal(isDecidable(makeDoc({ fakturaInfo: undefined })), false)
  })

  test('false when one rate has no status', () => {
    assert.equal(isDecidable(makeDoc({ fakturaInfo: { rate1: { status: 'Betalt' }, rate2: {}, rate3: { status: 'Betalt' } } })), false)
  })

  test('false when pcInfo is missing', () => {
    assert.equal(isDecidable(makeDoc({ pcInfo: undefined })), false)
  })
})

// =====================================================================
// Candidate query
// =====================================================================

describe('archiveResolvedPcIkkeInnlevert - candidate fetching', () => {
  test('queries only pcIkkeInnlevert, filtered to returned, bought-out or fully paid contracts', async () => {
    const { deps, queries } = makeDeps([])
    await archiveResolvedPcIkkeInnlevert(deps)

    assert.equal(queries.length, 1)
    assert.equal(queries[0].documentType, 'pcIkkeInnlevert')
    assert.deepEqual(queries[0].query, CANDIDATE_QUERY)
    assert.deepEqual(queries[0].query.$or[0], { 'pcInfo.returned': 'true' })
    assert.deepEqual(queries[0].query.$or[1], { 'pcInfo.boughtOut': 'true' })
    // Without this third branch the fully-paid rule would be unreachable - a contract with
    // neither pcInfo flag set would never be fetched in the first place
    assert.deepEqual(queries[0].query.$or[2], {
      $and: [
        { 'fakturaInfo.rate1.status': { $in: ['Betalt', 'Kreditert'] } },
        { 'fakturaInfo.rate2.status': { $in: ['Betalt', 'Kreditert'] } },
        { 'fakturaInfo.rate3.status': { $in: ['Betalt', 'Kreditert'] } }
      ]
    })
  })

  test('returns an empty report without throwing when getDocuments answers 404', async () => {
    const { deps, moveCalls } = makeDeps(null)
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(report.candidates, 0)
    assert.deepEqual(report.archived, [])
    assert.deepEqual(report.errors, [])
    assert.equal(moveCalls.length, 0)
  })
})

// =====================================================================
// Eligibility - delegated to determineHistoryMoveTarget, asserted end to end
// =====================================================================

describe('archiveResolvedPcIkkeInnlevert - eligibility', () => {
  test('archives a returned contract with every rate paid', async () => {
    const { deps, moveCalls } = makeDeps([makeDoc()])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.deepEqual(moveCalls, [{ documentId: 'doc-1', targetCollection: 'historic', sourceCollection: 'pcIkkeInnlevert' }])
    assert.equal(report.candidates, 1)
    assert.equal(report.archived.length, 1)
    assert.equal(report.archived[0].documentId, 'doc-1')
    assert.equal(report.archived[0].navn, 'Test Elev')
    assert.equal(report.archived[0].kontraktType, 'Leieavtale')
    assert.equal(report.archived[0].moved, true)
    assert.deepEqual(report.skippedStillUnresolved, [])
  })

  test('leaves a returned contract with an unpaid invoice in place', async () => {
    const doc = makeDoc({ fakturaInfo: rates('Betalt', 'Fakturert', 'Betalt') })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.archived.length, 0)
    assert.equal(report.skippedStillUnresolved.length, 1)
    // The rate statuses are the explanation for the skip, so they must reach the report
    assert.deepEqual(report.skippedStillUnresolved[0].rateStatuses, ['Betalt', 'Fakturert', 'Betalt'])
  })

  test('leaves a returned contract with a rate in "Overført inkasso" in place', async () => {
    const doc = makeDoc({ fakturaInfo: rates('Betalt', 'Betalt', 'Overført inkasso') })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedStillUnresolved.length, 1)
  })

  test('archives a returned contract with an "Ikke Fakturert" rate - allowed when returned', async () => {
    const doc = makeDoc({ fakturaInfo: rates('Betalt', 'Ikke Fakturert', 'Betalt') })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 1)
    assert.equal(report.archived.length, 1)
  })

  test('leaves a bought-out contract with an "Ikke Fakturert" rate in place - not allowed when bought out', async () => {
    const doc = makeDoc({
      pcInfo: { boughtOut: 'true' },
      fakturaInfo: rates('Betalt', 'Ikke Fakturert', 'Betalt')
    })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedStillUnresolved.length, 1)
  })

  test('archives a bought-out contract with every rate paid', async () => {
    const doc = makeDoc({ pcInfo: { boughtOut: 'true' } })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 1)
    assert.equal(report.archived.length, 1)
  })

  test('archives a fully paid contract with neither pcInfo flag set', async () => {
    const doc = makeDoc({ pcInfo: {}, fakturaInfo: rates('Betalt', 'Kreditert', 'Betalt') })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 1)
    assert.equal(report.archived.length, 1)
  })

  test('leaves a contract with neither pcInfo flag set and an unpaid rate in place', async () => {
    const doc = makeDoc({ pcInfo: {}, fakturaInfo: rates('Betalt', 'Betalt', 'Ikke Fakturert') })
    const { deps, moveCalls } = makeDeps([doc])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedStillUnresolved.length, 1)
  })

  test('reports an undecidable document instead of throwing, and keeps processing the rest', async () => {
    const broken = makeDoc({ _id: 'doc-broken', fakturaInfo: undefined })
    const fine = makeDoc({ _id: 'doc-fine' })
    const { deps, moveCalls } = makeDeps([broken, fine])
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(report.skippedIncomplete.length, 1)
    assert.equal(report.skippedIncomplete[0].documentId, 'doc-broken')
    assert.deepEqual(moveCalls.map(call => call.documentId), ['doc-fine'])
    assert.equal(report.archived.length, 1)
  })
})

// =====================================================================
// The invoices-collection gate (the predicate itself lives in invoiceChecks.test.js)
// =====================================================================

describe('archiveResolvedPcIkkeInnlevert - invoice gate', () => {
  test('blocks a settled contract that still has an unpaid extraInvoice', async () => {
    // The case the contract-rate rule cannot see: an extraInvoice has no fakturaInfo counterpart
    const invoices = [makeInvoice({ _id: 'invoice-x', status: 'Ikke Fakturert' })]
    const { deps, moveCalls } = makeDeps([makeDoc()], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.archived.length, 0)
    assert.equal(report.skippedUnsettledInvoices.length, 1)
    assert.equal(report.skippedUnsettledInvoices[0].documentId, 'doc-1')
    assert.deepEqual(report.skippedUnsettledInvoices[0].invoices, [
      { invoiceId: 'invoice-x', type: 'extraInvoice', status: 'Ikke Fakturert', rateStatuses: [] }
    ])
  })

  test('blocks on an invoice in "Overført inkasso"', async () => {
    const invoices = [makeInvoice({ status: 'Overført inkasso' })]
    const { deps, moveCalls } = makeDeps([makeDoc()], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedUnsettledInvoices.length, 1)
  })

  test('blocks on a buyOut invoice whose top-level status is settled but a rate is not', async () => {
    const invoices = [makeInvoice({ type: 'buyOut', status: 'Betalt', rates: [{ status: 'Betalt' }, { status: 'Fakturert' }] })]
    const { deps, moveCalls } = makeDeps([makeDoc()], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedUnsettledInvoices.length, 1)
    assert.deepEqual(report.skippedUnsettledInvoices[0].invoices[0].rateStatuses, ['Betalt', 'Fakturert'])
  })

  test('archives when every invoice is Betalt or Kreditert', async () => {
    const invoices = [
      makeInvoice({ _id: 'invoice-a', status: 'Betalt' }),
      makeInvoice({ _id: 'invoice-b', type: 'buyOut', status: 'Kreditert', rates: [{ status: 'Kreditert' }] })
    ]
    const { deps, moveCalls } = makeDeps([makeDoc()], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 1)
    assert.equal(report.archived.length, 1)
    assert.deepEqual(report.skippedUnsettledInvoices, [])
  })

  test('is a no-op when the contract has no invoices at all', async () => {
    const { deps, moveCalls } = makeDeps([makeDoc()], { invoices: [] })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 1)
    assert.equal(report.archived.length, 1)
  })

  test('only gates the contract the invoice actually belongs to', async () => {
    const blocked = makeDoc({ _id: 'doc-blocked' })
    const clean = makeDoc({ _id: 'doc-clean' })
    const invoices = [makeInvoice({ customerContractId: 'doc-blocked', status: 'Ikke Fakturert' })]
    const { deps, moveCalls } = makeDeps([blocked, clean], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.deepEqual(moveCalls.map(call => call.documentId), ['doc-clean'])
    assert.deepEqual(report.skippedUnsettledInvoices.map(entry => entry.documentId), ['doc-blocked'])
  })

  test('matches an invoice whose customerContractId is an ObjectId rather than a string', async () => {
    // Mongo hands back an ObjectId here; the job keys its lookup on String(...) so both forms work
    const objectId = { toString: () => 'doc-oid' }
    const doc = makeDoc({ _id: objectId })
    const invoices = [makeInvoice({ customerContractId: objectId, status: 'Ikke Fakturert' })]
    const { deps, moveCalls } = makeDeps([doc], { invoices })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 0)
    assert.equal(report.skippedUnsettledInvoices.length, 1)
  })

  test('fetches invoices in a single query regardless of how many candidates there are', async () => {
    const documents = ['a', 'b', 'c', 'd'].map(id => makeDoc({ _id: `doc-${id}` }))
    const { deps, invoiceQueries } = makeDeps(documents, { invoices: [makeInvoice()] })
    await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    const invoiceReads = invoiceQueries()
    assert.equal(invoiceReads.length, 1)
    // Every candidate is covered by the one query. Both id forms are matched (see
    // invoiceQueries.js), so a legacy string-valued customerContractId can't slip past either.
    const ids = invoiceReads[0].query.customerContractId.$in.map(String)
    for (const id of ['doc-a', 'doc-b', 'doc-c', 'doc-d']) {
      assert.ok(ids.includes(id), `candidate ${id} missing from the invoice query`)
    }
  })

  test('does not query invoices at all when there are no candidates', async () => {
    const { deps, invoiceQueries } = makeDeps([])
    await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(invoiceQueries().length, 0)
  })
})

// =====================================================================
// Dry run
// =====================================================================

describe('archiveResolvedPcIkkeInnlevert - dry run', () => {
  test('defaults to a preview: reports what it would archive but writes nothing', async () => {
    const { deps, moveCalls, teamsReports } = makeDeps([makeDoc()])
    const report = await archiveResolvedPcIkkeInnlevert(deps)

    assert.equal(report.dryRun, true)
    assert.equal(moveCalls.length, 0)
    assert.equal(report.candidates, 1)
    assert.equal(report.archived.length, 1)
    assert.equal(report.archived[0].moved, false)
    // A dry run must not notify anyone - the dev endpoint is meant to be pokeable
    assert.equal(teamsReports.length, 0)
  })

  test('posts the Teams report on a real run', async () => {
    const { deps, teamsReports } = makeDeps([makeDoc()])
    await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(teamsReports.length, 1)
    assert.equal(teamsReports[0].archived.length, 1)
  })

  test('a failing Teams report does not fail the run', async () => {
    const { deps } = makeDeps([makeDoc()])
    deps.postTeamsReportFn = async () => { throw new Error('webhook down') }
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(report.archived.length, 1)
    assert.deepEqual(report.errors, [])
  })
})

// =====================================================================
// Move failures
// =====================================================================

describe('archiveResolvedPcIkkeInnlevert - move failures', () => {
  test('records a 502 (Pureservice cf_2 reset failed) as an error and continues to the next document', async () => {
    const first = makeDoc({ _id: 'doc-fails' })
    const second = makeDoc({ _id: 'doc-succeeds' })
    const { deps, moveCalls } = makeDeps([first, second], {
      moveResult: (documentId) => documentId === 'doc-fails'
        ? { status: 502, error: 'Failed to reset cf_2 in Pureservice for user 345' }
        : { status: 200 }
    })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(moveCalls.length, 2)
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].documentId, 'doc-fails')
    assert.match(report.errors[0].error, /cf_2/)
    assert.deepEqual(report.archived.map(entry => entry.documentId), ['doc-succeeds'])
  })

  test('falls back to a status-based message when the failed move returns no error text', async () => {
    const { deps } = makeDeps([makeDoc()], { moveResult: { status: 500 } })
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0].error, /500/)
    assert.equal(report.archived.length, 0)
  })

  test('records a thrown move as an error and continues', async () => {
    const { deps } = makeDeps([makeDoc({ _id: 'doc-throws' }), makeDoc({ _id: 'doc-ok' })])
    deps.moveAndDeleteDocumentFn = async (documentId) => {
      if (documentId === 'doc-throws') throw new Error('connection reset')
      return { status: 200 }
    }
    const report = await archiveResolvedPcIkkeInnlevert(deps, { dryRun: false })

    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].error, 'connection reset')
    assert.deepEqual(report.archived.map(entry => entry.documentId), ['doc-ok'])
  })
})
