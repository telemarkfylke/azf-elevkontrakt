'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { checkIsDuplicate, findLatestHistoricalContract, applyHistoricalFakturaInfo, markAsSigned, determineHistoryMoveTarget, getFakturaInfoMismatches } = require('../contractChecks.js')

// ---- Helpers ---------------------------------------------------------------

const UTLAAN = 'Utlån faktureres ikke'

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

/**
 * Builds a mock mongoClient that behaves like a real Mongo collection with respect to
 * the { $regex, $options: 'i' } query shape checkIsDuplicate now uses — i.e. it actually
 * evaluates the regex against `storedKontraktType` instead of just returning a canned value.
 */
const buildRegexAwareClient = (storedFnr, storedKontraktType) => {
  const findOne = async (query) => {
    if (query['elevInfo.fnr'] !== storedFnr) return null
    const { $regex, $options } = query['unSignedskjemaInfo.kontraktType']
    const regex = new RegExp($regex, $options)
    return regex.test(storedKontraktType) ? { _id: '1' } : null
  }
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

/**
 * Builds a mock mongoClient that behaves like a real Mongo collection with respect to the
 * { $regex, $options: 'i' } kontraktType filter findLatestHistoricalContract now uses — i.e. it
 * actually filters `documents` by matching each one's unSignedskjemaInfo.kontraktType against the
 * regex, instead of always returning the full canned list regardless of query.
 */
const buildFindRegexAwareClient = (documents) => ({
  db: () => ({
    collection: () => ({
      find: (query) => {
        const { $regex, $options } = query['unSignedskjemaInfo.kontraktType']
        const regex = new RegExp($regex, $options)
        const matches = documents.filter(doc => regex.test(doc.unSignedskjemaInfo?.kontraktType))
        return {
          sort: () => ({
            limit: () => ({
              toArray: async () => matches
            })
          })
        }
      }
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

  // Guardrail regression test — the original reported bug: a document must never be merged with a
  // historicalContract of a different kontraktType, even if some future caller passes one by mistake.
  test('refuses to merge and returns document unchanged when kontraktType differs from historicalContract', () => {
    const doc = makeDocument({ unSignedskjemaInfo: { kontraktType: 'Leieavtale' } })
    const historicalContract = {
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: {
        rate1: { status: 'Utlån faktureres ikke', faktureringsår: 'Utlån faktureres ikke' },
        rate2: { status: 'Utlån faktureres ikke', faktureringsår: 'Utlån faktureres ikke' },
        rate3: { status: 'Utlån faktureres ikke', faktureringsår: 'Utlån faktureres ikke' }
      }
    }
    assert.deepEqual(applyHistoricalFakturaInfo(doc, historicalContract), doc)
  })

  // Regression: a Låneavtale is never invoiced, so it has no invoice history to inherit — merging can
  // only import corruption. Digitroll-imported Låneavtaler in 'historiske-avtaler' carry a real
  // faktureringsår next to the correct status, and since the year recalculation below only fires for
  // 'Ikke Fakturert' rates, that shape used to be copied straight onto brand-new contracts, which
  // getFakturaInfoMismatches then rejected to the error collection.
  test('never merges onto a Låneavtale, even from a legitimate same-type historical contract', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: {
        rate1: { status: UTLAAN, faktureringsår: UTLAAN },
        rate2: { status: UTLAAN, faktureringsår: UTLAAN },
        rate3: { status: UTLAAN, faktureringsår: UTLAAN }
      }
    })
    const historicalContract = {
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: {
        rate1: { status: UTLAAN, faktureringsår: '2025', faktureringsDato: 'Ukjent', betaltDato: 'Ukjent', sum: 'Ukjent' },
        rate2: { status: UTLAAN, faktureringsår: '2026', faktureringsDato: 'Ukjent', betaltDato: 'Ukjent', sum: 'Ukjent' },
        rate3: { status: UTLAAN, faktureringsår: '2027', faktureringsDato: 'Ukjent', betaltDato: 'Ukjent', sum: 'Ukjent' }
      }
    }

    const result = applyHistoricalFakturaInfo(doc, historicalContract)

    assert.deepEqual(result, doc)
    assert.deepEqual(getFakturaInfoMismatches(result), [])
  })

  test('skips the merge for a Låneavtale regardless of kontraktType casing', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'låneavtale' },
      fakturaInfo: {
        rate1: { status: UTLAAN, faktureringsår: UTLAAN },
        rate2: { status: UTLAAN, faktureringsår: UTLAAN },
        rate3: { status: UTLAAN, faktureringsår: UTLAAN }
      }
    })
    const historicalContract = {
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: makeHistoricalFakturaInfo()
    }

    assert.deepEqual(applyHistoricalFakturaInfo(doc, historicalContract), doc)
  })

  test('matches kontraktType case-insensitively before merging (does not refuse a legitimate same-type merge)', () => {
    const doc = makeDocument({ unSignedskjemaInfo: { kontraktType: 'leieavtale' } })
    const historicalContract = {
      unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
      fakturaInfo: makeHistoricalFakturaInfo()
    }
    const result = applyHistoricalFakturaInfo(doc, historicalContract)
    assert.equal(result.fakturaInfo.rate1.løpenummer, 'JOT-001')
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
// determineHistoryMoveTarget — pure function
// =====================================================================

const makeMoveTargetDoc = ({ returned = 'false', boughtOut = 'false', rateStatuses = ['Ikke Fakturert', 'Ikke Fakturert', 'Ikke Fakturert'] } = {}) => ({
  pcInfo: { returned, boughtOut },
  fakturaInfo: {
    rate1: { status: rateStatuses[0] },
    rate2: { status: rateStatuses[1] },
    rate3: { status: rateStatuses[2] }
  }
})

describe('determineHistoryMoveTarget', () => {
  test('returned, all rates "Ikke Fakturert" -> historic', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Ikke Fakturert', 'Ikke Fakturert', 'Ikke Fakturert'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
  })

  test('returned, all rates "Betalt" -> historic', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Betalt', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
  })

  test('returned, one rate "Utlån faktureres ikke", rest "Betalt" -> historic', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Utlån faktureres ikke', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
  })

  test('returned, one rate "Kreditert", rest "Betalt" -> historic', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Kreditert', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
  })

  test('returned, one rate "Fakturert" -> pcIkkeInnlevert', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Fakturert', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('returned, one rate "Overført inkasso" -> pcIkkeInnlevert', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Overført inkasso', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('returned, one rate with an unrecognized status -> pcIkkeInnlevert', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', rateStatuses: ['Ukjent', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('bought out, all rates "Betalt" -> historic', () => {
    const doc = makeMoveTargetDoc({ boughtOut: 'true', rateStatuses: ['Betalt', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
  })

  test('bought out, all rates "Ikke Fakturert" -> pcIkkeInnlevert (not allowed for bought-out)', () => {
    const doc = makeMoveTargetDoc({ boughtOut: 'true', rateStatuses: ['Ikke Fakturert', 'Ikke Fakturert', 'Ikke Fakturert'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('bought out, one rate "Fakturert" -> pcIkkeInnlevert', () => {
    const doc = makeMoveTargetDoc({ boughtOut: 'true', rateStatuses: ['Fakturert', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('neither returned nor bought out -> pcIkkeInnlevert', () => {
    const doc = makeMoveTargetDoc({ returned: 'false', boughtOut: 'false', rateStatuses: ['Betalt', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'pcIkkeInnlevert')
  })

  test('both returned and bought out, rates only satisfy the bought-out list -> historic', () => {
    const doc = makeMoveTargetDoc({ returned: 'true', boughtOut: 'true', rateStatuses: ['Skal ikke betale', 'Betalt', 'Betalt'] })
    assert.equal(determineHistoryMoveTarget(doc), 'historic')
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

  // Regression test — historically 'kontraktType' has been stored with inconsistent casing
  // (e.g. 'leieavtale' from older imports vs 'Leieavtale' from the ACOS form), which let a
  // second active contract of the same real-world type slip past the duplicate check.
  test('returns true when kontraktType differs only by casing (stored lowercase, checked capitalized)', async () => {
    const client = buildRegexAwareClient('12345678901', 'leieavtale')
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), true)
  })

  test('returns true when kontraktType differs only by casing (stored capitalized, checked lowercase)', async () => {
    const client = buildRegexAwareClient('12345678901', 'Leieavtale')
    assert.equal(await checkIsDuplicate('12345678901', 'leieavtale', client), true)
  })

  test('still returns false for a genuinely different kontraktType regardless of casing', async () => {
    const client = buildRegexAwareClient('12345678901', 'LÅNEAVTALE')
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), false)
  })

  test('does not throw or misbehave when kontraktType contains regex special characters', async () => {
    const client = buildRegexAwareClient('12345678901', 'Leieavtale (E)')
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale (E)', client), true)
    assert.equal(await checkIsDuplicate('12345678901', 'Leieavtale', client), false)
  })

  // Regression test — 8a5867f briefly added a 3rd findOne against 'historiske-avtaler' (the
  // same collection findLatestHistoricalContract checks for the legitimate merge case), which
  // caused a returning student's first legitimate new contract to be misclassified as a
  // duplicate and stranded in duplicatesCollection instead of being merged and posted to
  // kontrakter. checkIsDuplicate must only ever check 'kontrakter' and
  // 'historiske-avtaler-pc-ikke-innlevert' — a match in historical data alone is not a duplicate.
  test('only queries kontrakter and pcIkkeInnlevert — must not check historiske-avtaler for duplicates', async () => {
    let findOneCallCount = 0
    const findOne = async () => { findOneCallCount++; return null }
    const client = { db: () => ({ collection: () => ({ findOne }) }) }
    await checkIsDuplicate('12345678901', 'Leieavtale', client)
    assert.equal(findOneCallCount, 2)
  })
})

// =====================================================================
// findLatestHistoricalContract
// =====================================================================

describe('findLatestHistoricalContract', () => {
  test('returns the historical contract when one exists', async () => {
    const doc = { _id: 'abc', elevInfo: { fnr: '12345678901' }, generatedTimeStamp: '2023-01-01T00:00:00Z' }
    const client = buildFindClient([doc])
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
    assert.deepEqual(result, doc)
  })

  test('returns null when no historical contract found', async () => {
    const client = buildFindClient([])
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
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
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
    assert.equal(result._id, 'new')
  })

  // Regression tests for the reported bug: a student signing a new contract of one kontraktType
  // must never receive fakturaInfo merged from a historical contract of a DIFFERENT kontraktType
  // (e.g. a "Leieavtale" must not inherit a "Låneavtale"'s never-invoiced fakturaInfo, or vice versa).
  test('returns null when the only historical contract is of a different kontraktType', async () => {
    const laan = { _id: 'laan-1', unSignedskjemaInfo: { kontraktType: 'Låneavtale' }, generatedTimeStamp: '2024-01-01T00:00:00Z' }
    const client = buildFindRegexAwareClient([laan])
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
    assert.equal(result, null)
  })

  test('returns only the matching-kontraktType contract, even if a different-type contract is more recent', async () => {
    const leie = { _id: 'leie-1', unSignedskjemaInfo: { kontraktType: 'Leieavtale' }, generatedTimeStamp: '2022-01-01T00:00:00Z' }
    const laanNewer = { _id: 'laan-1', unSignedskjemaInfo: { kontraktType: 'Låneavtale' }, generatedTimeStamp: '2024-06-01T00:00:00Z' }
    const client = buildFindRegexAwareClient([leie, laanNewer])
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
    assert.equal(result._id, 'leie-1')
  })

  test('matches kontraktType case-insensitively (stored lowercase, checked capitalized)', async () => {
    const leie = { _id: 'leie-1', unSignedskjemaInfo: { kontraktType: 'leieavtale' }, generatedTimeStamp: '2024-01-01T00:00:00Z' }
    const client = buildFindRegexAwareClient([leie])
    const result = await findLatestHistoricalContract('12345678901', 'Leieavtale', client)
    assert.equal(result._id, 'leie-1')
  })

  test('does not throw or misbehave when kontraktType contains regex special characters', async () => {
    const leie = { _id: 'leie-1', unSignedskjemaInfo: { kontraktType: 'Leieavtale (E)' }, generatedTimeStamp: '2024-01-01T00:00:00Z' }
    const client = buildFindRegexAwareClient([leie])
    assert.equal((await findLatestHistoricalContract('12345678901', 'Leieavtale (E)', client))._id, 'leie-1')
    assert.equal(await findLatestHistoricalContract('12345678901', 'Leieavtale', client), null)
  })
})

// =====================================================================
// getFakturaInfoMismatches — pure function, the Layer 2 guardrail's detection logic
// =====================================================================

describe('getFakturaInfoMismatches', () => {
  const makeRate = (status, faktureringsår) => ({ status, faktureringsår })

  test('returns no issues for a legitimate Leieavtale (Ikke Fakturert, real billing years)', () => {
    const doc = makeDocument({ unSignedskjemaInfo: { kontraktType: 'Leieavtale' } })
    assert.deepEqual(getFakturaInfoMismatches(doc), [])
  })

  test('returns no issues for a legitimate Låneavtale (canonical Utlån faktureres ikke on all rates)', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: {
        rate1: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke'),
        rate2: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke'),
        rate3: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke')
      }
    })
    assert.deepEqual(getFakturaInfoMismatches(doc), [])
  })

  test('flags a Leieavtale rate whose status is Utlån faktureres ikke (inherited from a Låneavtale)', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
      fakturaInfo: {
        rate1: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke'),
        rate2: makeRate('Ikke Fakturert', '2024'),
        rate3: makeRate('Ikke Fakturert', '2025')
      }
    })
    const issues = getFakturaInfoMismatches(doc)
    assert.equal(issues.length, 1)
    assert.equal(issues[0].rateKey, 'rate1')
  })

  test('flags a Leieavtale rate whose faktureringsår is Utlån faktureres ikke even if status looks normal', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
      fakturaInfo: {
        rate1: makeRate('Ikke Fakturert', 'Utlån faktureres ikke'),
        rate2: makeRate('Ikke Fakturert', '2024'),
        rate3: makeRate('Ikke Fakturert', '2025')
      }
    })
    const issues = getFakturaInfoMismatches(doc)
    assert.equal(issues.length, 1)
    assert.equal(issues[0].rateKey, 'rate1')
  })

  test('flags a Låneavtale rate that has a real status/faktureringsår (inherited from a Leieavtale)', () => {
    const doc = makeDocument({
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: {
        rate1: makeRate('Ikke Fakturert', '2024'),
        rate2: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke'),
        rate3: makeRate('Utlån faktureres ikke', 'Utlån faktureres ikke')
      }
    })
    const issues = getFakturaInfoMismatches(doc)
    assert.equal(issues.length, 1)
    assert.equal(issues[0].rateKey, 'rate1')
  })

  test('returns no issues for an unrecognized/missing kontraktType (not this bug\'s concern)', () => {
    const doc = makeDocument({ unSignedskjemaInfo: { kontraktType: 'Ukjent' } })
    assert.deepEqual(getFakturaInfoMismatches(doc), [])
  })
})

// =====================================================================
// markAsSigned
// =====================================================================

describe('markAsSigned', () => {
  const makeUnsignedDocument = (overrides = {}) => ({
    isSigned: 'false',
    unSignedskjemaInfo: {
      refId: 'ref-1',
      acosName: 'skjema.pdf',
      kontraktType: 'Leieavtale',
      archiveDocumentNumber: '23/00077-60',
      createdTimeStamp: '2026-08-11T10:00:00.000Z'
    },
    signedSkjemaInfo: {
      refId: 'Ukjent',
      acosName: 'Ukjent',
      kontraktType: 'Ukjent',
      archiveDocumentNumber: 'Ukjent',
      createdTimeStamp: 'Ukjent'
    },
    signedBy: { navn: 'Ukjent', fnr: 'Ukjent' },
    ...overrides
  })

  test('sets isSigned to true and copies unSignedskjemaInfo onto signedSkjemaInfo', () => {
    const document = makeUnsignedDocument()
    const result = markAsSigned(document)
    assert.equal(result.isSigned, 'true')
    assert.deepEqual(result.signedSkjemaInfo, document.unSignedskjemaInfo)
  })

  test('copies ansvarligInfo onto signedBy when ansvarligInfo was resolved', () => {
    const document = makeUnsignedDocument({ ansvarligInfo: { navn: 'Kari Nordmann', fnr: '01019012345' } })
    const result = markAsSigned(document)
    assert.deepEqual(result.signedBy, { navn: 'Kari Nordmann', fnr: '01019012345' })
  })

  test('leaves signedBy untouched when ansvarligInfo is undefined', () => {
    const document = makeUnsignedDocument()
    const result = markAsSigned(document)
    assert.deepEqual(result.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('leaves signedBy untouched when ansvarligInfo is the Ukjent placeholder', () => {
    const document = makeUnsignedDocument({ ansvarligInfo: { navn: 'Ukjent', fnr: 'Ukjent' } })
    const result = markAsSigned(document)
    assert.deepEqual(result.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('does not mutate the original document', () => {
    const document = makeUnsignedDocument({ ansvarligInfo: { navn: 'Kari Nordmann', fnr: '01019012345' } })
    markAsSigned(document)
    assert.equal(document.isSigned, 'false')
    assert.equal(document.signedBy.navn, 'Ukjent')
  })
})
