'use strict'

/**
 * This job bills real students from a file an admin uploads, so the tests that matter most are the
 * ones asserting what it must NOT do: never invoice a Låneavtale, never guess between two contracts
 * for the same student, never write anything on a dry run, and never let one bad contract end a run
 * that has 700 students left in it.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  bulkInvoiceFromFile,
  detectFnrColumn,
  normalizeStudentFnr,
  looksLikeScientificNotation,
  selectRatesToInvoice,
  findContractDefect,
  RATE_STATUS_BY_MODE,
  INVOICE_LINE_LABEL_BY_MODE
} = require('../bulkInvoiceFromFile.js')
const { determineHistoryMoveTarget, FULLY_PAID_RATE_STATUSES } = require('../contractChecks.js')
const { checkRateCandidacy } = require('../updatePaymentStatus.js')

// ---- Fixtures ----

const rate = (status, faktureringsår) => ({ status, faktureringsår })

const baseContract = (overrides = {}) => ({
  _id: 'contract-1',
  unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
  elevInfo: { fnr: '01010112345', navn: 'Ola Nordmann', klasse: '2ELEA' },
  ansvarligInfo: { navn: 'Kari Nordmann', fnr: '02020254321' },
  pcInfo: { boughtOut: 'false' },
  fakturaInfo: {
    rate1: rate('Ikke Fakturert', '2025'),
    rate2: rate('Ikke Fakturert', '2026'),
    rate3: rate('Ikke Fakturert', '2027')
  },
  ...overrides
})

const PRICES = { prices: { regularPrice: 1500, reducedPrice: 500 }, exceptionsFromRegularPrices: { students: [], classes: [] }, exceptionsFromInvoiceFlow: { students: [] } }

/**
 * Records every write so a test can assert on what did *not* happen as easily as on what did.
 * `contracts` maps documentType -> the contracts that collection answers with.
 */
/**
 * `pendingInvoices` is what the 'invoices' collection answers with when the job checks whether a
 * contract already has an unsent buyOut waiting. It defaults to none, which is the normal case;
 * a test that wants the duplicate guard to fire supplies some.
 */
const makeDeps = ({ contracts = { regular: [], pcIkkeInnlevert: [] }, invoiceResult = { status: 200, body: 'ok' }, priceList = PRICES, exceptionFnrs = [], pendingInvoices = [] } = {}) => {
  const calls = { queries: [], invoiceLookups: [], invoices: [], pcStatus: [] }
  return {
    calls,
    deps: {
      getDocumentsFn: async (query, documentType) => {
        if (documentType === 'invoices') {
          calls.invoiceLookups.push(query)
          if (pendingInvoices.length === 0) return { status: 404, error: 'Fant ingen dokumenter' }
          return { status: 200, result: pendingInvoices }
        }
        calls.queries.push({ query, documentType })
        const result = contracts[documentType] ?? []
        const wanted = query['elevInfo.fnr'].$in
        const matching = result.filter(contract => wanted.includes(contract.elevInfo?.fnr))
        if (matching.length === 0) return { status: 404, error: 'Fant ingen dokumenter' }
        return { status: 200, result: matching }
      },
      updateContractPCStatusFn: async (contract, isMock, targetCollection) => {
        calls.pcStatus.push({ contract, isMock, targetCollection })
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
      createBuyOutInvoiceFn: async (contract, items, documentType, invoiceCreatedBy, opts) => {
        calls.invoices.push({ contractId: String(contract._id), items, documentType, invoiceCreatedBy, opts })
        return typeof invoiceResult === 'function' ? invoiceResult(contract) : invoiceResult
      },
      getThisYearsPriceListFn: async () => priceList,
      hasInvoiceFlowExceptionFn: (fnr) => exceptionFnrs.includes(fnr)
    }
  }
}

const csv = (...fnrs) => ['fnr', ...fnrs].join('\n')

// =====================================================================================
// Pure helpers
// =====================================================================================

describe('detectFnrColumn', () => {
  test('accepts each spelling the file might use', () => {
    for (const header of ['fnr', 'Fnr', 'FNR', 'fødselsnummer', 'Fodselsnummer', 'personnr', 'Personnummer', 'ssn', 'elevFnr']) {
      assert.equal(detectFnrColumn([header, 'navn']), header, `${header} should be recognised`)
    }
  })

  test('returns the header verbatim, so the caller can index the row with it', () => {
    assert.equal(detectFnrColumn(['  Fødselsnummer  ', 'navn']), '  Fødselsnummer  ')
  })

  test('an explicit override wins over an auto-detectable column', () => {
    assert.equal(detectFnrColumn(['fnr', 'ElevID'], 'ElevID'), 'ElevID')
  })

  test('an override is matched case-insensitively and trimmed', () => {
    assert.equal(detectFnrColumn(['ElevID'], '  elevid '), 'ElevID')
  })

  test('an override that is not in the file returns null - it must not silently fall back', () => {
    assert.equal(detectFnrColumn(['fnr', 'navn'], 'ElevID'), null)
  })

  test('returns null when nothing matches', () => {
    assert.equal(detectFnrColumn(['Skole', 'Fornavn', 'Etternavn', 'Klasse']), null)
    assert.equal(detectFnrColumn([]), null)
    assert.equal(detectFnrColumn(undefined), null)
  })

  // The header row of the real file, verbatim. Locked in so a rename of the candidate list cannot
  // quietly stop matching the one file this job was built for.
  const REAL_HEADERS = ['Skole', 'Fornavn', 'Etternavn', 'Klasse', 'Programområde', 'Fødselsnummer']

  test("finds 'Fødselsnummer' in the real file's header row", () => {
    assert.equal(detectFnrColumn(REAL_HEADERS), 'Fødselsnummer')
  })

  test("'ø' needs no normalising - U+00F8 has no canonical decomposition, so both forms are one string", () => {
    // Worth stating: the obvious worry about 'Fødselsnummer' arriving in two encodings does not
    // apply. 'ø' is a letter with a stroke, not a letter plus a combining mark.
    assert.equal('Fødselsnummer'.normalize('NFD'), 'Fødselsnummer'.normalize('NFC'))
    assert.equal(detectFnrColumn(['Skole', 'Fødselsnummer'.normalize('NFD')]), 'Fødselsnummer')
  })

  test("a header with a real combining diacritic still matches either way - 'å' does decompose", () => {
    // The case the NFC guard actually earns its place on, e.g. a column renamed 'Fødselsnummer (å jour)'
    // or any future candidate containing å/é. Demonstrated through the override, which is the path
    // that would otherwise leave an admin with no way through at all.
    const decomposed = 'Persondata å'.normalize('NFD')
    const precomposed = 'Persondata å'.normalize('NFC')
    assert.notEqual(decomposed, precomposed, 'å really does have two encodings')

    // Returned verbatim, so indexing the parsed row still works.
    assert.equal(detectFnrColumn(['Skole', decomposed], precomposed), decomposed)
    assert.equal(detectFnrColumn(['Skole', precomposed], decomposed), precomposed)
  })
})

describe('looksLikeScientificNotation', () => {
  test('recognises what Excel writes for a numeric column formatted General', () => {
    for (const value of ['1,01011E+10', '1.01011E+10', '1E+10', '1,01011e+10', ' 1,01011E+10 ']) {
      assert.equal(looksLikeScientificNotation(value), true, `${value} should be recognised`)
    }
  })

  test('does not misfire on a real fnr or on ordinary junk', () => {
    for (const value of ['01010112345', '1010112345', 'Ola Nordmann', '', '2E', 'E+10', 1010112345, null, undefined]) {
      assert.equal(looksLikeScientificNotation(value), false, `${JSON.stringify(value)} should not be recognised`)
    }
  })
})

describe('normalizeStudentFnr', () => {
  test('left-pads a 10-digit fnr - Excel eats the leading zero', () => {
    assert.equal(normalizeStudentFnr('1010112345'), '01010112345')
  })

  test('accepts a number, which is what a JSON/Excel export gives', () => {
    assert.equal(normalizeStudentFnr(1010112345), '01010112345')
  })

  test('strips spaces, dots and dashes', () => {
    assert.equal(normalizeStudentFnr('010101 12345'), '01010112345')
    assert.equal(normalizeStudentFnr('010101-12345'), '01010112345')
    assert.equal(normalizeStudentFnr('010101.12345'), '01010112345')
  })

  test('leaves a correct 11-digit fnr alone', () => {
    assert.equal(normalizeStudentFnr('01010112345'), '01010112345')
  })

  test('does NOT mod-11 check - a fiktivt fnr is a legitimate student here', () => {
    assert.equal(normalizeStudentFnr('01010100000'), '01010100000')
  })

  test('rejects anything that cannot be a fnr', () => {
    for (const value of ['', '   ', 'abc', '123456789012', 'Ola Nordmann', null, undefined, {}]) {
      assert.equal(normalizeStudentFnr(value), null, `${JSON.stringify(value)} must be rejected`)
    }
  })

  test('rejects a 9-digit orgnr padded to 11 would be wrong - length below 11 pads, so a 9-digit value becomes valid only as 11 digits', () => {
    // 974568098 -> 00974568098. Deliberate: we cannot tell a zero-stripped fnr from an orgnr, and the
    // contract lookup is what actually decides - an orgnr will simply match no student.
    assert.equal(normalizeStudentFnr('974568098'), '00974568098')
  })
})

describe('selectRatesToInvoice', () => {
  test('boughtOut takes every unpaid rate', () => {
    const { rates } = selectRatesToInvoice(baseContract(), 'boughtOut')
    assert.deepEqual(rates.map(r => r.rateKey), ['rate1', 'rate2', 'rate3'])
  })

  test('oneTime takes only the first unpaid rate, in rate1/2/3 order', () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Betalt', '2025'), rate2: rate('Ikke Fakturert', '2026'), rate3: rate('Ikke Fakturert', '2027') }
    })
    const { rates } = selectRatesToInvoice(contract, 'oneTime')
    assert.deepEqual(rates, [{ rateKey: 'rate2', faktureringsår: '2026' }])
  })

  test('no rate status other than "Ikke Fakturert" is ever selected', () => {
    for (const status of ['Fakturert', 'Fakturert - Utkjøp', 'Betalt', 'Kreditert', 'Overført inkasso', 'Skal ikke betale', 'Utlån faktureres ikke', 'Ukjent']) {
      const contract = baseContract({ fakturaInfo: { rate1: rate(status, '2025'), rate2: rate(status, '2026'), rate3: rate(status, '2027') } })
      assert.deepEqual(selectRatesToInvoice(contract, 'boughtOut').rates, [], `${status} must not be invoiceable`)
    }
  })

  test('a repeated faktureringsår yields ONE item plus a reported skip - createBuyOutInvoice matches by year alone and would bill the same rate twice', () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Ikke Fakturert', '2025'), rate2: rate('Ikke Fakturert', '2025'), rate3: rate('Betalt', '2027') }
    })
    const { rates, skippedRates } = selectRatesToInvoice(contract, 'boughtOut')
    assert.deepEqual(rates, [{ rateKey: 'rate1', faktureringsår: '2025' }])
    assert.deepEqual(skippedRates, [{ rateKey: 'rate2', faktureringsår: '2025', reason: 'duplicate-faktureringsår' }])
  })

  test('a rate with no faktureringsår is unmatchable and is dropped, not guessed at', () => {
    for (const year of [undefined, null, '']) {
      const contract = baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', year), rate2: rate('Betalt', '2026'), rate3: rate('Betalt', '2027') } })
      const { rates, skippedRates } = selectRatesToInvoice(contract, 'boughtOut')
      assert.deepEqual(rates, [])
      assert.equal(skippedRates[0].reason, 'missing-faktureringsår')
    }
  })

  test("'Ukjent' is a real Digitroll-era year and stays matchable", () => {
    const contract = baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', 'Ukjent'), rate2: rate('Betalt', '2026'), rate3: rate('Betalt', '2027') } })
    assert.deepEqual(selectRatesToInvoice(contract, 'boughtOut').rates, [{ rateKey: 'rate1', faktureringsår: 'Ukjent' }])
  })

  test('a numeric year deduped against the same year as a string', () => {
    const contract = baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', 2025), rate2: rate('Ikke Fakturert', '2025'), rate3: rate('Betalt', '2027') } })
    assert.equal(selectRatesToInvoice(contract, 'boughtOut').rates.length, 1)
  })
})

describe('findContractDefect', () => {
  test('a rate with no status is a defect - createBuyOutInvoice calls status.toLowerCase() on every rate and would throw', () => {
    assert.equal(findContractDefect(baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', '2025'), rate2: { faktureringsår: '2026' }, rate3: rate('Betalt', '2027') } })), 'malformed-fakturainfo')
  })

  test('a missing rate or missing fakturaInfo is a defect', () => {
    assert.equal(findContractDefect(baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', '2025') } })), 'malformed-fakturainfo')
    assert.equal(findContractDefect(baseContract({ fakturaInfo: undefined })), 'malformed-fakturainfo')
  })

  test('an unresolved ansvarlig is a defect - the invoice would have nobody to bill', () => {
    assert.equal(findContractDefect(baseContract({ ansvarligInfo: { navn: 'Ukjent', fnr: 'Ukjent' } })), 'ansvarlig-unresolved')
    assert.equal(findContractDefect(baseContract({ ansvarligInfo: undefined })), 'ansvarlig-unresolved')
  })

  test('a healthy contract has no defect', () => {
    assert.equal(findContractDefect(baseContract()), null)
  })
})

// =====================================================================================
// Orchestrator
// =====================================================================================

describe('bulkInvoiceFromFile - input validation', () => {
  test('rejects an unknown mode before reading anything', async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: csv('01010112345'), mode: 'refund' })
    assert.equal(report.fatal.reason, 'invalid-mode')
  })

  test("rejects 'history' - historiske-avtaler is not writable, so a contract there cannot be invoiced", async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: csv('01010112345'), mode: 'boughtOut', collections: ['regular', 'history'] })
    assert.equal(report.fatal.reason, 'invalid-collections')
    assert.deepEqual(report.fatal.invalidCollections, ['history'])
    assert.match(report.fatal.message, /historiske-avtaler/)
  })

  test('rejects an empty collections list', async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: csv('01010112345'), mode: 'boughtOut', collections: [] })
    assert.equal(report.fatal.reason, 'invalid-collections')
  })

  test('a file with no fødselsnummer column fails loudly, listing the headers it did find', async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: 'Skole;Fornavn;Etternavn\nBamble;Ola;Nordmann', mode: 'boughtOut' })
    assert.equal(report.fatal.reason, 'fnr-column-not-found')
    assert.deepEqual(report.fatal.headers, ['Skole', 'Fornavn', 'Etternavn'])
    assert.equal(report.invoiced.length, 0)
  })

  test('an empty file is fatal, not a successful run over nobody', async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: '', mode: 'boughtOut' })
    assert.equal(report.fatal.reason, 'empty-file')
  })

  test('every fatal exit still carries the full key set, so no caller null-checks a bucket', async () => {
    const report = await bulkInvoiceFromFile({}, { csvText: '', mode: 'boughtOut' })
    for (const key of ['dryRun', 'mode', 'collections', 'fnrColumn', 'fileRowCount', 'uniqueFnr', 'candidateContracts', 'invoiced', 'skipped', 'skippedRates', 'multiMatch', 'notFound', 'invalidRows', 'errors', 'totals']) {
      assert.ok(key in report, `${key} missing from a fatal report`)
    }
    assert.deepEqual(report.totals, { contracts: 0, rates: 0, sum: 0 })
  })
})

describe('bulkInvoiceFromFile - the real file', () => {
  // Exactly what Norwegian Excel produces from the delivered sheet: BOM, ';' separated,
  // 'Fødselsnummer' last, and a leading zero already eaten off the first student.
  const realFile = [
    '﻿Skole;Fornavn;Etternavn;Klasse;Programområde;Fødselsnummer',
    'Bamble;Ådne;Bakkerud;2ELEA;ELELE2----;1010112345',
    'Skogmo;Felix André;Ballestad;2ELEA;ELELE2----;02020254321'
  ].join('\r\n')

  test('parses, finds the column, and matches both students without any override', async () => {
    const contracts = [
      baseContract({ _id: 'a', elevInfo: { fnr: '01010112345', navn: 'Ådne Bakkerud', klasse: '2ELEA' } }),
      baseContract({ _id: 'b', elevInfo: { fnr: '02020254321', navn: 'Felix André Ballestad', klasse: '2ELEA' } })
    ]
    const { calls, deps } = makeDeps({ contracts: { regular: contracts, pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: realFile, mode: 'boughtOut', dryRun: false })

    assert.equal(report.fnrColumn, 'Fødselsnummer')
    assert.equal(report.fileRowCount, 2)
    assert.equal(report.uniqueFnr, 2)
    assert.equal(report.invalidRows.length, 0, 'the eaten leading zero must not read as a bad fnr')
    assert.deepEqual(report.invoiced.map(entry => entry.contractId), ['a', 'b'])
    assert.equal(calls.invoices.length, 2)
  })
})

describe('bulkInvoiceFromFile - a file Excel mangled', () => {
  test("a whole column of '1,01011E+10' is fatal and says how to fix it, rather than reading as a clean no-op", async () => {
    const mangled = 'Skole;Fødselsnummer\nBamble;1,01011E+10\nSkogmo;2,02022E+10'
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: mangled, mode: 'boughtOut', dryRun: false })

    assert.equal(report.fatal.reason, 'no-usable-fnr')
    assert.match(report.fatal.message, /Tekst i Excel/, 'the message has to name the fix')
    assert.equal(report.invalidRows.length, 2)
    assert.ok(report.invalidRows.every(entry => entry.reason === 'fnr-lost-to-excel-formatting'))
    assert.equal(calls.invoices.length, 0)
  })

  test('a file of plain junk fnr is fatal too, without blaming Excel for it', async () => {
    const junk = 'Skole;Fødselsnummer\nBamble;ikke-et-fnr\nSkogmo;'
    const { deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: junk, mode: 'boughtOut', dryRun: false })

    assert.equal(report.fatal.reason, 'no-usable-fnr')
    assert.doesNotMatch(report.fatal.message, /Excel/)
  })

  test('one mangled row among good ones is reported per-row and does NOT stop the run', async () => {
    const mixed = 'Skole;Fødselsnummer\nBamble;1,01011E+10\nSkogmo;01010112345'
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: mixed, mode: 'boughtOut', dryRun: false })

    assert.equal(report.fatal, null)
    assert.equal(report.invalidRows[0].reason, 'fnr-lost-to-excel-formatting')
    assert.equal(calls.invoices.length, 1)
  })
})

describe('bulkInvoiceFromFile - matching students', () => {
  test('invoices a matched Leieavtale and reports the rates and sum', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.invoiced.length, 1)
    assert.equal(report.invoiced[0].documentType, 'regular')
    assert.deepEqual(report.invoiced[0].rates.map(r => r.rateKey), ['rate1', 'rate2', 'rate3'])
    assert.deepEqual(report.totals, { contracts: 1, rates: 3, sum: 4500 })
    assert.equal(calls.invoices.length, 1)
    assert.deepEqual(calls.invoices[0].items, [
      { faktureringsår: '2025', sum: 1500 },
      { faktureringsår: '2026', sum: 1500 },
      { faktureringsår: '2027', sum: 1500 }
    ])
  })

  test('a 10-digit fnr in the file matches the 11-digit fnr on the contract', async () => {
    const { deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('1010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(report.invoiced.length, 1)
  })

  test('searches both collections and keeps the documentType the contract was found in', async () => {
    const contract = baseContract({ _id: 'contract-pc' })
    const { calls, deps } = makeDeps({ contracts: { regular: [], pcIkkeInnlevert: [contract] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.deepEqual(calls.queries.map(q => q.documentType), ['regular', 'pcIkkeInnlevert'])
    assert.equal(report.invoiced[0].documentType, 'pcIkkeInnlevert')
    assert.equal(calls.invoices[0].documentType, 'pcIkkeInnlevert', 'the invoice must record the collection the contract actually lives in')
  })

  test('a student with two contracts is reported and NEVER invoiced - the job must not guess', async () => {
    const { calls, deps } = makeDeps({
      contracts: { regular: [baseContract({ _id: 'a' })], pcIkkeInnlevert: [baseContract({ _id: 'b' })] }
    })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.multiMatch.length, 1)
    assert.deepEqual(report.multiMatch[0].contracts, [
      { contractId: 'a', documentType: 'regular' },
      { contractId: 'b', documentType: 'pcIkkeInnlevert' }
    ])
    assert.equal(report.invoiced.length, 0)
    assert.equal(calls.invoices.length, 0, 'no invoice may be created when two contracts match')
  })

  test('an fnr with no contract lands in notFound', async () => {
    const { deps } = makeDeps({ contracts: { regular: [], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.deepEqual(report.notFound, [{ fnr: '01010112345' }])
  })

  test('an unusable fnr is reported as an invalid row, and does not abort the run', async () => {
    const { deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('ikke-et-fnr', '01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(report.invalidRows.length, 1)
    assert.equal(report.invalidRows[0].reason, 'invalid-fnr')
    assert.equal(report.invoiced.length, 1)
  })

  test('the same fnr twice in the file is billed once', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345', '01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(calls.invoices.length, 1)
    assert.equal(report.invalidRows[0].reason, 'duplicate-fnr-in-file')
    assert.equal(report.uniqueFnr, 1)
  })
})

describe('bulkInvoiceFromFile - what must never be invoiced', () => {
  test('a Låneavtale is skipped and createBuyOutInvoice is NEVER called - a Låneavtale is never billed', async () => {
    const contract = baseContract({
      unSignedskjemaInfo: { kontraktType: 'Låneavtale' },
      fakturaInfo: { rate1: rate('Ikke Fakturert', '2025'), rate2: rate('Ikke Fakturert', '2026'), rate3: rate('Ikke Fakturert', '2027') }
    })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.invoices.length, 0, 'a Låneavtale must never reach createBuyOutInvoice')
    assert.equal(calls.pcStatus.length, 0, 'and must not be marked bought out either')
    assert.equal(report.skipped[0].reason, 'not-leieavtale')
    assert.equal(report.skipped[0].kontraktType, 'Låneavtale')
  })

  test('kontraktType casing is irrelevant - both spellings exist in the data', async () => {
    for (const kontraktType of ['Leieavtale', 'leieavtale', 'LEIEAVTALE']) {
      const { calls, deps } = makeDeps({ contracts: { regular: [baseContract({ unSignedskjemaInfo: { kontraktType } })], pcIkkeInnlevert: [] } })
      await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
      assert.equal(calls.invoices.length, 1, `${kontraktType} should be invoiced`)
    }
  })

  test('a contract with nothing left to invoice is skipped, which is what a re-run of the same file looks like', async () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Fakturert - Utkjøp', '2025'), rate2: rate('Betalt', '2026'), rate3: rate('Kreditert', '2027') }
    })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.skipped[0].reason, 'no-unpaid-rates')
    assert.equal(calls.invoices.length, 0)
  })

  test('a student excluded from the invoice flow is skipped', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, exceptionFnrs: ['01010112345'] })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(report.skipped[0].reason, 'invoice-flow-exception')
    assert.equal(calls.invoices.length, 0)
  })

  test('a contract with an unresolved ansvarlig is skipped rather than billed to nobody', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract({ ansvarligInfo: { navn: 'Ukjent', fnr: 'Ukjent' } })], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(report.skipped[0].reason, 'ansvarlig-unresolved')
    assert.equal(calls.invoices.length, 0)
  })

  test('a malformed contract is reported, not thrown on', async () => {
    const contract = baseContract({ fakturaInfo: { rate1: rate('Ikke Fakturert', '2025'), rate2: { faktureringsår: '2026' }, rate3: rate('Betalt', '2027') } })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(report.skipped[0].reason, 'malformed-fakturainfo')
    assert.equal(calls.invoices.length, 0)
  })
})

/**
 * The guard against a double-submitted run. createBuyOutInvoice decides billability from the contract
 * object its caller loaded, not a fresh read, so two runs that both load a contract before either
 * writes will both bill it - which is exactly what a double-clicked submit did across a whole file,
 * leaving two pending invoices per contract.
 */
describe('bulkInvoiceFromFile - a contract that already has an unsent invoice', () => {
  const pending = [{ _id: 'invoice-1', type: 'buyOut', status: 'Ikke Fakturert', customerContractId: 'contract-1' }]

  test('is skipped rather than billed a second time', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, pendingInvoices: pending })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.invoices.length, 0, 'no second invoice may be created')
    assert.equal(report.invoiced.length, 0)
    assert.equal(report.skipped[0].reason, 'pending-invoice-exists')
    assert.deepEqual(report.skipped[0].pendingInvoiceIds, ['invoice-1'])
  })

  test('is skipped on a dry run too, so the preview does not promise an invoice the real run would refuse', async () => {
    const { deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, pendingInvoices: pending })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut' })

    assert.equal(report.invoiced.length, 0)
    assert.equal(report.skipped[0].reason, 'pending-invoice-exists')
  })

  test('the lookup is scoped to pending buyOuts for that one contract, and is a fresh read per contract', async () => {
    const contracts = [
      baseContract({ _id: 'a', elevInfo: { fnr: '01010112341', navn: 'A', klasse: '2A' } }),
      baseContract({ _id: 'b', elevInfo: { fnr: '01010112342', navn: 'B', klasse: '2A' } })
    ]
    const { calls, deps } = makeDeps({ contracts: { regular: contracts, pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112341', '01010112342'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.invoiceLookups.length, 2, 'one fresh lookup per contract - a cached answer would be as stale as the bug')
    for (const query of calls.invoiceLookups) {
      assert.equal(query.type, 'buyOut')
      assert.equal(query.status, 'Ikke Fakturert', 'an already-sent invoice must not block a legitimate re-run')
      assert.ok(query.customerContractId, 'scoped to the contract, never a collection-wide check')
    }
  })

  test('the guard runs after the cheap checks, so a Låneavtale costs no invoice lookup', async () => {
    const lane = baseContract({ unSignedskjemaInfo: { kontraktType: 'Låneavtale' } })
    const { calls, deps } = makeDeps({ contracts: { regular: [lane], pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.invoiceLookups.length, 0)
  })
})

describe('bulkInvoiceFromFile - dry run', () => {
  test('writes NOTHING and still previews the rates and sums', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: true })

    assert.equal(calls.invoices.length, 0, 'no invoice may be created on a dry run')
    assert.equal(calls.pcStatus.length, 0, 'no pcInfo may be written on a dry run')
    assert.equal(report.invoiced.length, 1)
    assert.deepEqual(report.totals, { contracts: 1, rates: 3, sum: 4500 })
    assert.equal(report.dryRun, true)
  })

  test('dryRun defaults to true when the caller omits it', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut' })
    assert.equal(report.dryRun, true)
    assert.equal(calls.invoices.length, 0)
  })
})

describe('bulkInvoiceFromFile - the two modes', () => {
  test("boughtOut marks the contract bought out and passes the utkjøp rate status", async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false, invoiceCreatedBy: { email: 'admin@telemarkfylke.no' } })

    assert.equal(calls.pcStatus.length, 1)
    assert.deepEqual(calls.pcStatus[0].contract, { contractID: 'contract-1', buyOutPC: 'true', upn: 'admin@telemarkfylke.no' })
    assert.equal(calls.pcStatus[0].targetCollection, undefined, "targetCollectionFor('regular') is undefined")
    assert.equal(calls.invoices[0].opts.rateStatusOnInvoice, 'Fakturert - Utkjøp')
  })

  test('boughtOut on a pcIkkeInnlevert contract writes to that collection', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [], pcIkkeInnlevert: [baseContract()] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(calls.pcStatus[0].targetCollection, 'pcIkkeInnlevert')
  })

  test('boughtOut does not rewrite the flag when it is already set, but still invoices the remaining rates', async () => {
    const contract = baseContract({ pcInfo: { boughtOut: 'true' } })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.pcStatus.length, 0)
    assert.equal(calls.invoices.length, 1, 'invoicing is gated on rate status, not on the flag - so a failed earlier attempt self-heals')
  })

  test("oneTime bills one rate, passes the plain 'Fakturert' status, and leaves pcInfo alone", async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'oneTime', dryRun: false })

    assert.equal(calls.pcStatus.length, 0, 'a one-off termin invoice is not a buyout')
    assert.deepEqual(calls.invoices[0].items, [{ faktureringsår: '2025', sum: 1500 }])
    assert.equal(calls.invoices[0].opts.rateStatusOnInvoice, 'Fakturert')
    assert.deepEqual(report.totals, { contracts: 1, rates: 1, sum: 1500 })
  })

  test("oneTime labels the invoice LINE 'Leie av elev-PC' - the guardian must not be told their PC was bought out", async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'oneTime', dryRun: false })
    assert.equal(calls.invoices[0].opts.invoiceLineLabel, 'Leie av elev-PC')
  })

  test('boughtOut passes no label, so a real buyout keeps its existing invoice wording', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.equal(calls.invoices[0].opts.invoiceLineLabel, undefined)
  })

  test('the mode maps are the single source for both modes', () => {
    assert.deepEqual(RATE_STATUS_BY_MODE, { boughtOut: 'Fakturert - Utkjøp', oneTime: 'Fakturert' })
    assert.deepEqual(INVOICE_LINE_LABEL_BY_MODE, { boughtOut: undefined, oneTime: 'Leie av elev-PC' })
  })
})

// =====================================================================================
// Both modes reach the end of a contract's life
//
// These were characterisation tests for a real gap: 'Fakturert - Utkjøp' was written to a contract
// rate and read by no consumer, so a boughtOut contract could never reach 'Betalt' and never archive.
// checkRateCandidacy (updatePaymentStatus.js) now accepts it, and these assert the loop is closed.
// See docs/bulk-invoice-from-file.md.
// =====================================================================================

describe('both modes leave a contract able to finish its life', () => {
  test('the payment sweep asks about whichever status the mode writes', () => {
    for (const mode of ['boughtOut', 'oneTime']) {
      assert.equal(
        checkRateCandidacy({ status: RATE_STATUS_BY_MODE[mode], løpenummer: 'JOT-000000001-2-2026-abc123' }),
        true,
        `${mode} writes '${RATE_STATUS_BY_MODE[mode]}', which the sweep must pick up or the rate never becomes Betalt`
      )
    }
  })

  test('an invoiced-but-unpaid contract is still held back from the archive', () => {
    for (const mode of ['boughtOut', 'oneTime']) {
      const invoiced = {
        pcInfo: { returned: 'false', boughtOut: 'true' },
        fakturaInfo: {
          rate1: { status: RATE_STATUS_BY_MODE[mode] },
          rate2: { status: RATE_STATUS_BY_MODE[mode] },
          rate3: { status: RATE_STATUS_BY_MODE[mode] }
        }
      }
      assert.equal(determineHistoryMoveTarget(invoiced), 'pcIkkeInnlevert', `${mode}: unpaid must not archive`)
    }
  })

  test('once paid, it archives', () => {
    const paid = {
      pcInfo: { returned: 'false', boughtOut: 'true' },
      fakturaInfo: { rate1: { status: 'Betalt' }, rate2: { status: 'Betalt' }, rate3: { status: 'Betalt' } }
    }
    assert.equal(determineHistoryMoveTarget(paid), 'historic')
  })

  test('the fix stayed out of contractChecks - putting it there would archive genuinely unpaid contracts', () => {
    assert.equal(FULLY_PAID_RATE_STATUSES.includes(RATE_STATUS_BY_MODE.boughtOut), false)
    assert.equal(FULLY_PAID_RATE_STATUSES.includes(RATE_STATUS_BY_MODE.oneTime), false)
  })
})

describe('bulkInvoiceFromFile - rate-level skips are kept out of the student-level bucket', () => {
  test('a dropped rate goes to skippedRates while the contract is still invoiced for the rest', async () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Ikke Fakturert', '2025'), rate2: rate('Ikke Fakturert', '2025'), rate3: rate('Ikke Fakturert', '2027') }
    })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.skipped.length, 0, 'the student was NOT skipped - they were invoiced')
    assert.equal(report.skippedRates.length, 1)
    assert.deepEqual(report.skippedRates[0].reason, 'duplicate-faktureringsår')
    assert.equal(report.skippedRates[0].rateKey, 'rate2')
    assert.equal(report.invoiced.length, 1)
    assert.equal(calls.invoices[0].items.length, 2)
  })

  test("a contract whose every unpaid rate is unmatchable reads 'unmatchable-rates', not 'no-unpaid-rates' - it still owes money", async () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Ikke Fakturert', null), rate2: rate('Betalt', '2026'), rate3: rate('Betalt', '2027') }
    })
    const { calls, deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.skipped[0].reason, 'unmatchable-rates')
    assert.equal(report.skippedRates[0].reason, 'missing-faktureringsår')
    assert.equal(calls.invoices.length, 0)
  })

  test("a settled contract still reads 'no-unpaid-rates' - re-running a file must look boring", async () => {
    const contract = baseContract({
      fakturaInfo: { rate1: rate('Betalt', '2025'), rate2: rate('Betalt', '2026'), rate3: rate('Betalt', '2027') }
    })
    const { deps } = makeDeps({ contracts: { regular: [contract], pcIkkeInnlevert: [] } })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.skipped[0].reason, 'no-unpaid-rates')
    assert.equal(report.skippedRates.length, 0)
  })
})

describe('bulkInvoiceFromFile - an unusable price list', () => {
  test('is refused up front instead of throwing on the first student and losing the whole report', async () => {
    const unusable = [
      {},
      { prices: { regularPrice: 1500 } },
      { prices: { regularPrice: 1500 }, exceptionsFromRegularPrices: { students: [] } },
      { prices: { regularPrice: 1500 }, exceptionsFromRegularPrices: { classes: [] } },
      { exceptionsFromRegularPrices: { students: [], classes: [] } }
    ]
    for (const priceList of unusable) {
      const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, priceList })
      const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

      assert.equal(report.fatal?.reason, 'price-list-unavailable', `${JSON.stringify(priceList)} should be refused`)
      assert.equal(calls.invoices.length, 0, 'nothing may be billed without a usable price list')
    }
  })

  test('a price list that comes back undefined entirely is refused too', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    deps.getThisYearsPriceListFn = async () => undefined
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.fatal.reason, 'price-list-unavailable')
    assert.equal(calls.invoices.length, 0)
  })

  test('a missing exceptionsFromInvoiceFlow is tolerated - it only ever narrows who gets billed', async () => {
    const priceList = { prices: { regularPrice: 1500 }, exceptionsFromRegularPrices: { students: [], classes: [] } }
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, priceList })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.fatal, null)
    assert.equal(calls.invoices.length, 1)
  })
})

describe('bulkInvoiceFromFile - pricing', () => {
  test('a reduced-price class gets the reduced price', async () => {
    const priceList = { ...PRICES, exceptionsFromRegularPrices: { students: [], classes: [{ className: '2ELEA' }] } }
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, priceList })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.ok(calls.invoices[0].items.every(item => item.sum === 500))
  })

  test('a per-student exception gets the reduced price', async () => {
    const priceList = { ...PRICES, exceptionsFromRegularPrices: { students: [{ fnr: '01010112345' }], classes: [] } }
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] }, priceList })
    await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })
    assert.ok(calls.invoices[0].items.every(item => item.sum === 500))
  })
})

describe('bulkInvoiceFromFile - failures mid-run', () => {
  test('one failing contract is recorded and the rest of the run continues', async () => {
    const contracts = [
      baseContract({ _id: 'a', elevInfo: { fnr: '01010112341', navn: 'A', klasse: '2A' } }),
      baseContract({ _id: 'b', elevInfo: { fnr: '01010112342', navn: 'B', klasse: '2A' } }),
      baseContract({ _id: 'c', elevInfo: { fnr: '01010112343', navn: 'C', klasse: '2A' } })
    ]
    const { calls, deps } = makeDeps({
      contracts: { regular: contracts, pcIkkeInnlevert: [] },
      invoiceResult: (contract) => (contract._id === 'b' ? { status: 500, body: 'Could not update rate2' } : { status: 200, body: 'ok' })
    })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112341', '01010112342', '01010112343'), mode: 'boughtOut', dryRun: false })

    assert.equal(calls.invoices.length, 3, 'every contract must still be attempted')
    assert.deepEqual(report.invoiced.map(entry => entry.contractId), ['a', 'c'])
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].contractId, 'b')
    assert.equal(report.errors[0].stage, 'createBuyOutInvoice')
    assert.equal(report.errors[0].status, 500)
    assert.equal(report.totals.contracts, 2, 'a failed contract must not be counted as invoiced')
  })

  test('a thrown error is contained the same way', async () => {
    const { deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    deps.createBuyOutInvoiceFn = async () => { throw new Error('Mongo gikk ned') }
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.errors[0].error, 'Mongo gikk ned')
    assert.equal(report.invoiced.length, 0)
  })

  test('a failed boughtOut flag is reported but does not stop the invoicing - the rates are the point', async () => {
    const { calls, deps } = makeDeps({ contracts: { regular: [baseContract()], pcIkkeInnlevert: [] } })
    deps.updateContractPCStatusFn = async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
    const report = await bulkInvoiceFromFile(deps, { csvText: csv('01010112345'), mode: 'boughtOut', dryRun: false })

    assert.equal(report.errors[0].stage, 'boughtOut-flag')
    assert.equal(calls.invoices.length, 1)
    assert.equal(report.invoiced.length, 1)
  })
})
