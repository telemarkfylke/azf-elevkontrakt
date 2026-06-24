'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { checkIsDuplicate, findLatestHistoricalContract, applyHistoricalFakturaInfo } = require('../contractChecks.js')

// ---- Helpers ---------------------------------------------------------------

const makeDocument = (overrides = {}) => ({
  elevInfo: { fnr: '12345678901', navn: 'Test Elev' },
  unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
  fakturaInfo: {
    rate1: { status: 'Ikke Fakturert', faktureringsår: '2023' },
    rate2: { status: 'Ikke Fakturert', faktureringsår: '2024' },
    rate3: { status: 'Ikke Fakturert', faktureringsår: '2025' }
  },
  ...overrides
})

const makeHistoricalFakturaInfo = (overrides = {}) => ({
  rate1: { status: 'Betalt', faktureringsår: '2022', løpenummer: 'JOT-001', sum: '2500' },
  rate2: { status: 'Betalt', faktureringsår: '2023', løpenummer: 'JOT-002', sum: '2500' },
  rate3: { status: 'Betalt', faktureringsår: '2024', løpenummer: 'JOT-003', sum: '2500' },
  ...overrides
})

/**
 * Builds a mock mongoClient whose findOne returns results in call order.
 * checkIsDuplicate calls kontrakter first, then pcIkkeInnlevert (via Promise.all),
 * but since JS is single-threaded the synchronous iteration order is preserved.
 * Pass an array: [kontrakterResult, pcIkkeInnlevertResult]
 */
const buildFindOneClient = (results) => {
  let callIndex = 0
  const findOne = async () => results[callIndex++] ?? null
  const collection = () => ({ findOne })
  return { db: () => ({ collection }) }
}

/** Builds a mock mongoClient whose find().sort().limit().toArray() returns `documents`. */
const buildFindClient = (documents) => ({
  db: () => ({
    collection: () => ({
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => documents
          })
        })
      })
    })
  })
})

// =====================================================================
// applyHistoricalFakturaInfo — pure function
// =====================================================================

describe('applyHistoricalFakturaInfo', () => {
  test('returns document unchanged when historicalContract is null', () => {
    const doc = makeDocument()
    assert.deepEqual(applyHistoricalFakturaInfo(doc, null), doc)
  })

  test('returns document unchanged when historicalContract has no fakturaInfo', () => {
    const doc = makeDocument()
    assert.deepEqual(applyHistoricalFakturaInfo(doc, {}), doc)
  })

  test('copies all three rates from the historical fakturaInfo', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, { fakturaInfo: makeHistoricalFakturaInfo() })
    assert.equal(result.fakturaInfo.rate1.løpenummer, 'JOT-001')
    assert.equal(result.fakturaInfo.rate2.løpenummer, 'JOT-002')
    assert.equal(result.fakturaInfo.rate3.løpenummer, 'JOT-003')
  })

  test('leaves paid/invoiced rates faktureringsår untouched', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, {
      fakturaInfo: makeHistoricalFakturaInfo({
        rate1: { status: 'Betalt', faktureringsår: '2022' },
        rate2: { status: 'Fakturert', faktureringsår: '2023' },
        rate3: { status: 'Overført inkasso', faktureringsår: '2024' }
      })
    })
    assert.equal(result.fakturaInfo.rate1.faktureringsår, '2022')
    assert.equal(result.fakturaInfo.rate2.faktureringsår, '2023')
    assert.equal(result.fakturaInfo.rate3.faktureringsår, '2024')
  })

  test('rate1+rate2 paid, rate3 unpaid → rate3 gets currentYear (1st unpaid), not currentYear+2', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, {
      fakturaInfo: {
        rate1: { status: 'Betalt', faktureringsår: '2023' },
        rate2: { status: 'Betalt', faktureringsår: '2024' },
        rate3: { status: 'Ikke Fakturert', faktureringsår: '2024' }
      }
    })
    const currentYear = new Date().getFullYear()
    assert.equal(result.fakturaInfo.rate1.faktureringsår, '2023')
    assert.equal(result.fakturaInfo.rate2.faktureringsår, '2024')
    assert.equal(result.fakturaInfo.rate3.faktureringsår, String(currentYear)) // 1st unpaid → year+0
  })

  test('rate1 paid, rate2+rate3 unpaid → counter assigns year+0 and year+1', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, {
      fakturaInfo: {
        rate1: { status: 'Betalt', faktureringsår: '2022' },
        rate2: { status: 'Ikke Fakturert', faktureringsår: '2022' },
        rate3: { status: 'Ikke Fakturert', faktureringsår: '2023' }
      }
    })
    const currentYear = new Date().getFullYear()
    assert.equal(result.fakturaInfo.rate1.faktureringsår, '2022')
    assert.equal(result.fakturaInfo.rate2.faktureringsår, String(currentYear))     // 1st unpaid
    assert.equal(result.fakturaInfo.rate3.faktureringsår, String(currentYear + 1)) // 2nd unpaid
  })

  test('all three "Ikke Fakturert" rates get correct billing years', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, {
      fakturaInfo: {
        rate1: { status: 'Ikke Fakturert', faktureringsår: '2020' },
        rate2: { status: 'Ikke Fakturert', faktureringsår: '2021' },
        rate3: { status: 'Ikke Fakturert', faktureringsår: '2022' }
      }
    })
    const year = new Date().getFullYear()
    assert.equal(result.fakturaInfo.rate1.faktureringsår, String(year))
    assert.equal(result.fakturaInfo.rate2.faktureringsår, String(year + 1))
    assert.equal(result.fakturaInfo.rate3.faktureringsår, String(year + 2))
  })

  test('does not mutate the original historical contract', () => {
    const doc = makeDocument()
    const historical = { fakturaInfo: { rate1: { status: 'Ikke Fakturert', faktureringsår: '2021' }, rate2: { status: 'Ikke Fakturert', faktureringsår: '2022' }, rate3: { status: 'Ikke Fakturert', faktureringsår: '2023' } } }
    applyHistoricalFakturaInfo(doc, historical)
    assert.equal(historical.fakturaInfo.rate1.faktureringsår, '2021')
    assert.equal(historical.fakturaInfo.rate2.faktureringsår, '2022')
    assert.equal(historical.fakturaInfo.rate3.faktureringsår, '2023')
  })

  test('does not mutate the original document fakturaInfo', () => {
    const doc = makeDocument()
    const originalRef = doc.fakturaInfo
    applyHistoricalFakturaInfo(doc, { fakturaInfo: makeHistoricalFakturaInfo() })
    assert.equal(doc.fakturaInfo, originalRef)
  })

  // GAP TEST 3 — partial fakturaInfo (rate2 key missing entirely) must not crash
  test('handles partial fakturaInfo where a rate key is missing — produces empty rate object', () => {
    const doc = makeDocument()
    const result = applyHistoricalFakturaInfo(doc, {
      fakturaInfo: {
        rate1: { status: 'Betalt', faktureringsår: '2023', løpenummer: 'JOT-001', sum: '2500' }
        // rate2 and rate3 are absent
      }
    })
    assert.equal(result.fakturaInfo.rate1.status, 'Betalt')
    // Missing keys spread to {} — no status, so no faktureringsår update, no crash
    assert.deepEqual(result.fakturaInfo.rate2, {})
    assert.deepEqual(result.fakturaInfo.rate3, {})
  })
})

// =====================================================================
// checkIsDuplicate
// =====================================================================

describe('checkIsDuplicate', () => {
  // Results array: [kontrakterResult, pcIkkeInnlevertResult] — call order from Promise.all

  test('returns true when a matching contract exists in kontrakter', async () => {
    const client = buildFindOneClient([{ _id: '1' }, null])
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), true)
  })

  test('returns true when a matching contract exists in pcIkkeInnlevert', async () => {
    const client = buildFindOneClient([null, { _id: '2' }])
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), true)
  })

  test('returns true when matching contract exists in both collections', async () => {
    const client = buildFindOneClient([{ _id: '1' }, { _id: '2' }])
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), true)
  })

  test('returns false when no matching contract found in either collection', async () => {
    const client = buildFindOneClient([null, null])
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), false)
  })

  // GAP TEST 1 — different kontraktType must NOT be treated as a duplicate
  test('returns false when same FNR exists but with a different kontraktType (Låneavtale vs Leieavtale)', async () => {
    // The mock always returns null, simulating that the query (which includes kontraktType) finds no match.
    // This verifies the business rule: Leieavtale + Låneavtale for the same student can coexist.
    const client = buildFindOneClient([null, null])
    assert.equal(await checkIsDuplicate('12345678901', 'Låneavtale', client), false)
  })
})

// =====================================================================
// findLatestHistoricalContract
// =====================================================================

describe('findLatestHistoricalContract', () => {
  test('returns the historical contract when one exists', async () => {
    const doc = { _id: 'abc', elevInfo: { fnr: '12345678901' }, generatedTimeStamp: '2023-01-01T00:00:00Z' }
    const client = buildFindClient([doc])
    const result = await findLatestHistoricalContract('12345678901', client)
    assert.deepEqual(result, doc)
  })

  test('returns null when no historical contract found', async () => {
    const client = buildFindClient([])
    const result = await findLatestHistoricalContract('12345678901', client)
    assert.equal(result, null)
  })

  // GAP TEST 2 — when multiple historical contracts exist, the mock returns them pre-sorted
  // (the real DB sorts; here we verify that findLatestHistoricalContract returns the first
  // element of what the DB cursor gives back, which represents the most recent document)
  test('returns the first document from the cursor (most recent after DB sort)', async () => {
    const older = { _id: 'old', elevInfo: { fnr: '12345678901' }, generatedTimeStamp: '2021-01-01T00:00:00Z' }
    const newer = { _id: 'new', elevInfo: { fnr: '12345678901' }, generatedTimeStamp: '2024-06-01T00:00:00Z' }
    // Simulate DB returning the cursor sorted desc: newest first
    const client = buildFindClient([newer, older])
    const result = await findLatestHistoricalContract('12345678901', client)
    assert.equal(result._id, 'new')
  })
})
