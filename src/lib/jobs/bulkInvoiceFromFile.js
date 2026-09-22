'use strict'

/**
 * Bulk-invoices the remaining unpaid rates for a list of students supplied as a CSV file.
 *
 * Why this exists: a student who never returned their PC is counted as bought out, but that is only
 * correct once every rate that is neither invoiced nor paid has actually been billed. Nothing could
 * do that for a list of students. The nightly normalInvoice run only ever bills the *current* school
 * year's rate (getXledgerInvoiceImports, xledgerInvoiceImport.js), and the only path that bills all
 * remaining rates - handleBoughtOut in syncPureserviceAssetLifecycle.js - is driven one student at a
 * time by Pureservice asset registrations. So it was done by hand, per student, in the admin cart UI.
 *
 * This job is the same work as handleBoughtOut, over a file. It deliberately reuses
 * createBuyOutInvoice rather than building invoice documents itself, so the rate-matching,
 * serial-number minting and contract write-back can never drift from the single-student path. Nothing
 * downstream needs to change: the invoice lands in 'invoices' with status 'Ikke Fakturert' and the
 * existing nightly sweep (processInvoices, xledgerExtraInvoice.js) ships it to Xledger.
 *
 * Only a Leieavtale is ever invoiced. A Låneavtale is never billed - its rates are permanently
 * 'Utlån faktureres ikke' - and getFakturaInfoMismatches (contractChecks.js) already treats a
 * Låneavtale with billable rates as a corruption to report rather than act on.
 *
 * See docs/bulk-invoice-from-file.md.
 */

const { logger } = require('@vtfk/logger')
const { getDocuments, updateContractPCStatus } = require('./queryMongoDB')
const { createBuyOutInvoice } = require('./processInvoices')
const { targetCollectionFor } = require('./updatePCStatus')
const { assertContractUpdated } = require('./findContract')
const { getThisYearsPriceList } = require('../helpers/getSettings')
const { returnCorrectPriceForStudent } = require('../helpers/getCorrectRatePrice')
const { hasInvoiceFlowException } = require('../helpers/checkInvoiceFlowException')
const { invoiceQueryForContractIds } = require('./invoiceQueries')
const { parseCSVString } = require('../helpers/readAndParseCSV')
const { normalizeIdentifier, detectIdentifierType, FNR_LENGTH } = require('../helpers/identifier')
const { maskFnr } = require('../helpers/maskFnr')

/**
 * The contract collections a student can be invoiced in.
 *
 * 'history' is deliberately absent and must stay absent: updateDocument (queryMongoDB.js) has no
 * 'history' branch, so a contract in 'historiske-avtaler' physically cannot have its rate flipped.
 * Invoicing one would post an invoice whose contract never records it - the same invariant
 * updateImportedBuyOutDocument refuses outright.
 */
const CANDIDATE_COLLECTIONS = ['regular', 'pcIkkeInnlevert']

const MODES = ['boughtOut', 'oneTime']

const RATE_KEYS = ['rate1', 'rate2', 'rate3']

/**
 * The only rate status that may be invoiced. Same predicate handleBoughtOut selects on and same one
 * createBuyOutInvoice matches on, so the three cannot disagree about what "unpaid" means.
 */
const INVOICEABLE_RATE_STATUS = 'Ikke Fakturert'

/**
 * mode -> the status written to the contract's rate.
 *
 * 'oneTime' is not a buyout. It bills a single outstanding termin - typically one the nightly run
 * will never pick up, because that run filters on the current school year - so its rate must read
 * 'Fakturert' like any ordinary termin invoice. It travels the buyOut rails only because those are
 * the rails that can bill an arbitrary rate; createBuyOutInvoice stores the value on the invoice so
 * the Xledger import re-applies the right one.
 */
const RATE_STATUS_BY_MODE = Object.freeze({
  boughtOut: 'Fakturert - Utkjøp',
  oneTime: 'Fakturert'
})

/**
 * mode -> the description printed on the invoice LINE the recipient reads.
 *
 * The status above is internal; this is the sentence on the document a guardian pays against, so it
 * matters more, not less. undefined for a buyout keeps the existing wording byte for byte
 * (buildInvoiceLineText, xledgerExtraInvoice.js); 'Leie av elev-PC' is exactly what the nightly rent
 * invoice prints, which is what a one-off termin invoice is.
 */
const INVOICE_LINE_LABEL_BY_MODE = Object.freeze({
  boughtOut: undefined,
  oneTime: 'Leie av elev-PC'
})

/**
 * Header names an fnr column is accepted under, lowercased and NFC-normalised. An explicit override
 * beats all of them. 'Fødselsnummer' is what the real file uses.
 */
const FNR_COLUMN_CANDIDATES = ['fnr', 'fødselsnummer', 'fodselsnummer', 'føsdelsnummer', 'personnr', 'personnummer', 'ssn', 'elevfnr'].map(name => name.normalize('NFC'))

/**
 * Header names are compared case-insensitively, trimmed, and NFC-normalised.
 *
 * The NFC part is defensive rather than load-bearing for the current file: 'ø' (U+00F8) is a letter
 * with a stroke and has no canonical decomposition, so 'Fødselsnummer' is the same string either way.
 * It does matter for a header carrying a real combining diacritic - 'å' decomposes to 'a' + U+030A,
 * and a file that has been through macOS can carry the decomposed form, which is not `===` equal to
 * the precomposed one however identical it looks. Cheap to do here, and it also fixes the escape
 * hatch: without it a hand-passed fnrColumn would miss in exactly the same way the auto-detection
 * did, leaving no way through.
 */
const normalizeHeader = (header) => header.normalize('NFC').trim().toLowerCase()

/**
 * Finds the column holding the student's fnr.
 *
 * Returns null rather than guessing when nothing matches. That failure has to be loud: a wrong or
 * missing column invoices nobody while every other part of the run reports success, which reads
 * exactly like "none of these students were eligible".
 *
 * @param {Array<String>} headers - header names as parsed (BOM already stripped by parseCSVString)
 * @param {String} [override] - header name supplied by the caller
 * @returns {String|null} - the header name to read, verbatim as it appears in the file
 */
const detectFnrColumn = (headers, override) => {
  const available = (headers ?? []).filter(header => typeof header === 'string' && header.length > 0)
  if (override) {
    const wanted = normalizeHeader(override)
    return available.find(header => normalizeHeader(header) === wanted) ?? null
  }
  return available.find(header => FNR_COLUMN_CANDIDATES.includes(normalizeHeader(header))) ?? null
}

/**
 * Excel writes a numeric cell to CSV in scientific notation when the column is formatted General and
 * the value is wide enough - a fødselsnummer column that was never set to Text comes out as
 * '1,01011E+10'. The digits are gone for good at that point, so the row cannot be salvaged.
 *
 * Detected separately from a plain bad value only so the report can say what to fix. Otherwise all
 * 775 rows come back as 'invalid-fnr' with no hint that the file needs re-saving, which is a
 * genuinely confusing half hour.
 *
 * @param {String|Number} value - the RAW cell value, before normalizeIdentifier strips punctuation
 */
const looksLikeScientificNotation = (value) =>
  typeof value === 'string' && /^\d(?:[.,]\d+)?[eE]\+?\d+$/.test(value.trim())

/**
 * Normalises a fnr as it survives a trip through Excel.
 *
 * Excel treats a fnr as a number and eats the leading zero, so roughly a tenth of all fnr arrive 10
 * digits long. Left-padding is what the Digitroll import already does (importDigitrollStudents.js).
 * No mod-11 check: a fiktivt fødselsnummer frequently fails it, and those are legitimate students
 * here (see detectIdentifierType, identifier.js).
 *
 * @param {String|Number} value
 * @returns {String|null} - an 11-digit fnr, or null if the value cannot be one
 */
const normalizeStudentFnr = (value) => {
  const normalized = normalizeIdentifier(value)
  if (!/^\d+$/.test(normalized)) return null
  const padded = normalized.length < FNR_LENGTH ? normalized.padStart(FNR_LENGTH, '0') : normalized
  return detectIdentifierType(padded) === 'fnr' ? padded : null
}

/**
 * Picks the rates to invoice on one contract.
 *
 * The faktureringsår dedupe is load-bearing, not tidiness: createBuyOutInvoice matches an item to a
 * rate by faktureringsår alone and does not mark the matched rate consumed, so two items sharing a
 * year would both match the same rate and bill it twice. Digitroll-era data can carry a repeated
 * year. A rate with no faktureringsår at all is unmatchable for the same reason and is dropped too.
 *
 * @param {Object} contract
 * @param {'boughtOut'|'oneTime'} mode
 * @returns {{rates: Array<{rateKey: String, faktureringsår: *}>, skippedRates: Array<{rateKey: String, faktureringsår: *, reason: String}>}}
 */
const selectRatesToInvoice = (contract, mode) => {
  const unpaid = []
  for (const rateKey of RATE_KEYS) {
    const rate = contract?.fakturaInfo?.[rateKey]
    if (rate?.status === INVOICEABLE_RATE_STATUS) {
      unpaid.push({ rateKey, faktureringsår: rate.faktureringsår })
    }
  }

  // 'oneTime' bills the first outstanding rate, in rate1/rate2/rate3 order.
  const candidates = mode === 'oneTime' ? unpaid.slice(0, 1) : unpaid

  const rates = []
  const skippedRates = []
  const seenYears = new Set()
  for (const candidate of candidates) {
    const year = candidate.faktureringsår
    if (year === undefined || year === null || year === '') {
      skippedRates.push({ ...candidate, reason: 'missing-faktureringsår' })
      continue
    }
    const key = String(year)
    if (seenYears.has(key)) {
      skippedRates.push({ ...candidate, reason: 'duplicate-faktureringsår' })
      continue
    }
    seenYears.add(key)
    rates.push(candidate)
  }
  return { rates, skippedRates }
}

/**
 * createBuyOutInvoice walks every rate on the contract calling rate.status.toLowerCase(), so a rate
 * with no status throws before it can reach a match. One malformed contract must not abort a
 * 775-row run, so it is reported here instead.
 * @returns {String|null} - a skip reason, or null when the contract is safe to invoice
 */
const findContractDefect = (contract) => {
  if (!contract?.fakturaInfo) return 'malformed-fakturainfo'
  for (const rateKey of RATE_KEYS) {
    const rate = contract.fakturaInfo[rateKey]
    if (!rate || typeof rate.status !== 'string') return 'malformed-fakturainfo'
  }
  const ansvarligFnr = contract.ansvarligInfo?.fnr
  if (!ansvarligFnr || ansvarligFnr === 'Ukjent') return 'ansvarlig-unresolved'
  return null
}

/**
 * Whether a settings price can actually be turned into an amount.
 *
 * Number() is too permissive on its own: `Number('')` and `Number(' ')` are 0, not NaN, so a blank
 * price would sail through and bill everyone 0 kroner rather than failing. Anything empty is a
 * missing price, not a free PC.
 *
 * @param {String|Number} value
 * @returns {Boolean}
 */
const isPriceable = (value) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return Number.isFinite(Number(value))
}

const isLeieavtale = (contract) =>
  contract?.unSignedskjemaInfo?.kontraktType?.toLowerCase() === 'leieavtale'

/**
 * Whether a contract already has an unsent buyOut invoice waiting.
 *
 * This is the guard against a double-submitted run, and it is read FRESH per contract rather than
 * from the bulk pre-fetch on purpose - a pre-fetched answer is exactly as stale as the contract
 * status that let the duplicate through in the first place.
 *
 * Why the contract's own rate status is not enough: createBuyOutInvoice decides billability from the
 * contract object its caller loaded, not from a fresh read, so two runs that both load a contract
 * before either writes will both see 'Ikke Fakturert' and both post an invoice. That is not a
 * theoretical race - a double-clicked submit did it across a whole file. This check closes the window
 * to the few milliseconds between the query and the insert, and catches the realistic case where the
 * second run reaches a student the first run has already finished.
 *
 * Mirrors the pending-extraInvoice guard in generateInvoices (processInvoices.js), which returns 409
 * for the same reason.
 *
 * @returns {Promise<Array<Object>>} - the pending buyOut invoices, empty when there are none
 */
const findPendingBuyOutInvoices = async (contractId, getDocumentsFn) => {
  const query = { ...invoiceQueryForContractIds([contractId]), type: 'buyOut', status: 'Ikke Fakturert' }
  const result = await getDocumentsFn(query, 'invoices')
  if (result.status !== 200 || !result.result?.length) return []
  return result.result
}

/**
 * Every exit path returns this same key set, so a caller never has to null-check a bucket.
 *
 * **This report is personal data by design, and deliberately unmasked.** `notFound`, `multiMatch`
 * and `skipped` carry real fødselsnumre because the whole point is that an admin can match entries
 * back to the rows of the file they just uploaded; maskFnr here would make the report useless for
 * the one job it has. The endpoint is gated on elevkontrakt.administrator-readwrite accordingly.
 * That is a decision, not an oversight - the logs a few lines down DO mask, and the difference is
 * intentional.
 *
 * `invalidRows` is the exception: it identifies a bad row by line number and the offending cell
 * only, never the whole row. The rest of the row is the admin's own file and tells them nothing
 * they did not already have.
 */
const emptyReport = (overrides = {}) => ({
  dryRun: true,
  mode: null,
  collections: [],
  fnrColumn: null,
  fileRowCount: 0,
  uniqueFnr: 0,
  candidateContracts: 0,
  invoiced: [],
  skipped: [],
  // Rates dropped from an otherwise invoiced contract. Kept apart from `skipped` on purpose: a
  // student there got no invoice at all, and a reader scanning that bucket must not have to check
  // whether each entry means the whole student or just one of their rates.
  skippedRates: [],
  multiMatch: [],
  notFound: [],
  invalidRows: [],
  errors: [],
  totals: { contracts: 0, rates: 0, sum: 0 },
  fatal: null,
  ...overrides
})

/**
 * Reads every candidate contract out of the chosen collections in one query per collection and
 * indexes them by fnr - the bulk-prefilter pattern from invoiceChecks.js, rather than a query per
 * student. A student can hold more than one contract, so the index is many-valued.
 * @returns {Promise<Map<String, Array<{contract: Object, documentType: String}>>>}
 */
const fetchContractsByFnr = async (fnrList, collections, getDocumentsFn) => {
  const byFnr = new Map()
  if (fnrList.length === 0) return byFnr

  for (const documentType of collections) {
    const result = await getDocumentsFn({ 'elevInfo.fnr': { $in: fnrList } }, documentType)
    // 404 = no contracts in this collection, which just leaves the index short - not an error.
    if (result.status !== 200 || !result.result?.length) continue
    for (const contract of result.result) {
      const fnr = contract.elevInfo?.fnr
      if (!fnr) continue
      if (!byFnr.has(fnr)) byFnr.set(fnr, [])
      byFnr.get(fnr).push({ contract, documentType })
    }
  }
  return byFnr
}

/**
 * @param {Object} [deps]
 * @param {Object} [options]
 * @param {String} options.csvText - the uploaded file's text
 * @param {'boughtOut'|'oneTime'} options.mode - boughtOut invoices every remaining unpaid rate and
 *   marks the contract bought out; oneTime invoices the first unpaid rate only and touches no pcInfo
 * @param {Array<String>} [options.collections] - subset of CANDIDATE_COLLECTIONS, defaults to both
 * @param {String} [options.fnrColumn] - header-name override for the fnr column
 * @param {Boolean} [options.dryRun] - true (default): preview only, no writes
 * @param {Object} [options.invoiceCreatedBy] - stamped on every invoice created by this run
 * @returns {Promise<Object>} - the report described by emptyReport
 */
const bulkInvoiceFromFile = async (deps = {}, options = {}) => {
  const {
    getDocumentsFn = getDocuments,
    updateContractPCStatusFn = updateContractPCStatus,
    createBuyOutInvoiceFn = createBuyOutInvoice,
    getThisYearsPriceListFn = getThisYearsPriceList,
    returnCorrectPriceForStudentFn = returnCorrectPriceForStudent,
    hasInvoiceFlowExceptionFn = hasInvoiceFlowException,
    parseCSVStringFn = parseCSVString
  } = deps

  const {
    csvText,
    mode,
    collections = CANDIDATE_COLLECTIONS,
    fnrColumn: fnrColumnOverride,
    dryRun = true,
    invoiceCreatedBy = {}
  } = options

  const logPrefix = 'bulkInvoiceFromFile'

  if (!MODES.includes(mode)) {
    return emptyReport({ dryRun, fatal: { reason: 'invalid-mode', message: `mode må være en av: ${MODES.join(', ')}` } })
  }

  const invalidCollections = collections.filter(collection => !CANDIDATE_COLLECTIONS.includes(collection))
  if (collections.length === 0 || invalidCollections.length > 0) {
    return emptyReport({
      dryRun,
      mode,
      fatal: {
        reason: 'invalid-collections',
        // Said plainly because it is the one constraint an admin will not guess: historiske-avtaler
        // is not writable, so a contract there cannot be invoiced at all.
        message: `collections må være en eller flere av: ${CANDIDATE_COLLECTIONS.join(', ')}. Kontrakter i historiske-avtaler kan ikke faktureres - arkivet er ikke skrivbart.`,
        invalidCollections
      }
    })
  }

  const rows = parseCSVStringFn(csvText, 'opplastet fil')
  if (rows.length === 0) {
    return emptyReport({ dryRun, mode, collections, fatal: { reason: 'empty-file', message: 'Fant ingen rader i filen' } })
  }

  const headers = Object.keys(rows[0])
  const fnrColumn = detectFnrColumn(headers, fnrColumnOverride)
  if (!fnrColumn) {
    return emptyReport({
      dryRun,
      mode,
      collections,
      fileRowCount: rows.length,
      fatal: {
        reason: 'fnr-column-not-found',
        message: fnrColumnOverride
          ? `Fant ingen kolonne som heter '${fnrColumnOverride}' i filen`
          : `Fant ingen fødselsnummerkolonne. Forventet en av: ${FNR_COLUMN_CANDIDATES.join(', ')}. Send fnrColumn for å overstyre.`,
        headers
      }
    })
  }

  const report = emptyReport({ dryRun, mode, collections, fnrColumn, fileRowCount: rows.length })

  // Normalise and dedupe the file before touching the database. A repeated fnr in the file must not
  // become two invoicing attempts on the same contract.
  const fnrList = []
  const seenFnr = new Set()
  for (const [index, row] of rows.entries()) {
    const rawFnr = row[fnrColumn]
    const fnr = normalizeStudentFnr(rawFnr)
    // +2 puts this on the line number the admin sees in Excel: +1 for the header, +1 for 1-based rows.
    const line = index + 2
    if (!fnr) {
      report.invalidRows.push({
        line,
        value: rawFnr,
        reason: looksLikeScientificNotation(rawFnr) ? 'fnr-lost-to-excel-formatting' : 'invalid-fnr'
      })
      continue
    }
    if (seenFnr.has(fnr)) {
      report.invalidRows.push({ line, value: fnr, reason: 'duplicate-fnr-in-file' })
      continue
    }
    seenFnr.add(fnr)
    fnrList.push(fnr)
  }
  report.uniqueFnr = fnrList.length

  // Without this the run proceeds, queries nothing, reports nothing, and reads as a clean no-op -
  // the same "looks like success but did nothing" shape a missing fnr column would have had.
  if (fnrList.length === 0) {
    const lostToExcel = report.invalidRows.filter(entry => entry.reason === 'fnr-lost-to-excel-formatting').length
    return {
      ...report,
      fatal: {
        reason: 'no-usable-fnr',
        message: lostToExcel > 0
          ? `Ingen brukbare fødselsnumre i '${fnrColumn}'. ${lostToExcel} av ${rows.length} rader er skrevet på formen '1,01011E+10' - formater kolonnen som Tekst i Excel og lagre CSV-fila på nytt.`
          : `Ingen brukbare fødselsnumre i kolonnen '${fnrColumn}' (${rows.length} rader lest)`
      }
    }
  }

  logger('info', [logPrefix, `Starter - mode: ${mode}, collections: ${collections.join(',')}, rader: ${rows.length}, unike fnr: ${fnrList.length}, dryRun: ${dryRun}`])

  const contractsByFnr = await fetchContractsByFnr(fnrList, collections, getDocumentsFn)
  report.candidateContracts = [...contractsByFnr.values()].reduce((count, entries) => count + entries.length, 0)

  // Validated up front rather than discovered inside the loop. returnCorrectPriceForStudent reads
  // .students and .classes unguarded, so a settings document missing either would throw on the first
  // student and take the whole report down with it - including the record of everything already
  // billed by that point.
  const priceList = await getThisYearsPriceListFn()
  const { prices, exceptionsFromRegularPrices, exceptionsFromInvoiceFlow } = priceList ?? {}
  if (!prices || !Array.isArray(exceptionsFromRegularPrices?.students) || !Array.isArray(exceptionsFromRegularPrices?.classes)) {
    return { ...report, fatal: { reason: 'price-list-unavailable', message: 'Prislisten i settings mangler eller har feil form - kan ikke prise noen rater' } }
  }
  /**
   * Prisene er strenger i settings. En som ikke er et tall ('3 500', '3.500,-') gir NaN på hver
   * rate, og NaN forplanter seg gjennom report.totals.sum til hele summen - stille, siden hver
   * enkelt faktura fortsatt "ser riktig ut".
   *
   * Sjekkes her sammen med resten av prislisten, slik at det stopper FØR noe er fakturert i stedet
   * for å bli oppdaget på totalen etterpå.
   */
  const unpriceable = ['regularPrice', 'reducedPrice'].filter(key => prices[key] !== undefined && !isPriceable(prices[key]))
  if (!isPriceable(prices.regularPrice) || unpriceable.length > 0) {
    return {
      ...report,
      fatal: {
        reason: 'price-list-unavailable',
        message: `Prislisten i settings har en pris som ikke er et tall (${unpriceable.join(', ') || 'regularPrice'}) - kan ikke prise noen rater`
      }
    }
  }
  const invoiceFlowExceptions = Array.isArray(exceptionsFromInvoiceFlow?.students) ? exceptionsFromInvoiceFlow : { students: [] }

  // Sequential on purpose. Each contract mints up to three serial numbers and generateSerialNumber
  // is a read-then-write on a shared counter with no locking - running these concurrently would hand
  // two invoices the same løpenummer.
  for (const fnr of fnrList) {
    const matches = contractsByFnr.get(fnr) ?? []

    if (matches.length === 0) {
      report.notFound.push({ fnr })
      continue
    }
    if (matches.length > 1) {
      // Never guess which contract to bill.
      report.multiMatch.push({
        fnr,
        navn: matches[0].contract.elevInfo?.navn,
        contracts: matches.map(({ contract, documentType }) => ({ contractId: String(contract._id), documentType }))
      })
      continue
    }

    const { contract, documentType } = matches[0]
    const student = {
      fnr,
      navn: contract.elevInfo?.navn,
      contractId: String(contract._id),
      documentType
    }

    if (!isLeieavtale(contract)) {
      report.skipped.push({ ...student, reason: 'not-leieavtale', kontraktType: contract.unSignedskjemaInfo?.kontraktType })
      continue
    }

    const defect = findContractDefect(contract)
    if (defect) {
      report.skipped.push({ ...student, reason: defect })
      continue
    }

    if (hasInvoiceFlowExceptionFn(fnr, invoiceFlowExceptions)) {
      // The Xledger sweep would hold this back anyway; skipping here keeps the reservation off the
      // contract so nothing has to be unwound when the exception is lifted.
      report.skipped.push({ ...student, reason: 'invoice-flow-exception' })
      continue
    }

    const { rates, skippedRates } = selectRatesToInvoice(contract, mode)
    for (const skippedRate of skippedRates) {
      report.skippedRates.push({ ...student, rateKey: skippedRate.rateKey, faktureringsår: skippedRate.faktureringsår, reason: skippedRate.reason })
    }
    if (rates.length === 0) {
      // Distinguished deliberately: 'no-unpaid-rates' means there was nothing to do, which is the
      // normal result of re-running a file. 'unmatchable-rates' means the contract DOES owe money
      // that this job refused to bill - a data problem somebody has to look at.
      report.skipped.push({ ...student, reason: skippedRates.length > 0 ? 'unmatchable-rates' : 'no-unpaid-rates' })
      continue
    }

    const items = rates.map(rate => ({
      faktureringsår: rate.faktureringsår,
      sum: returnCorrectPriceForStudentFn(fnr, contract.elevInfo?.klasse, prices, exceptionsFromRegularPrices)
    }))
    const total = items.reduce((sum, item) => sum + Number(item.sum), 0)
    const invoicedEntry = {
      ...student,
      rates: rates.map((rate, index) => ({ ...rate, sum: items[index].sum })),
      total
    }

    // Checked even on a dry run, so the preview tells you a contract is already spoken for rather
    // than promising an invoice that the real run would then refuse.
    const pending = await findPendingBuyOutInvoices(contract._id, getDocumentsFn)
    if (pending.length > 0) {
      report.skipped.push({
        ...student,
        reason: 'pending-invoice-exists',
        pendingInvoiceIds: pending.map(invoice => String(invoice._id))
      })
      continue
    }

    if (dryRun) {
      report.invoiced.push(invoicedEntry)
      continue
    }

    // Marked bought out before invoicing, mirroring handleBoughtOut. Safe in either order:
    // 'Ikke Fakturert' is not in BOUGHT_OUT_ALLOWED_RATE_STATUSES, so the contract cannot slip into
    // the final archive between the two writes.
    if (mode === 'boughtOut' && contract.pcInfo?.boughtOut !== 'true') {
      try {
        const pcResult = await updateContractPCStatusFn(
          { contractID: student.contractId, buyOutPC: 'true', upn: invoiceCreatedBy.email ?? 'masseinnfakturering' },
          false,
          targetCollectionFor(documentType)
        )
        const { updated, reason } = assertContractUpdated(pcResult, `${logPrefix} - pcInfo på kontrakt ${student.contractId} i '${documentType}'`)
        if (!updated) {
          // Not fatal for this student: the rates are what get billed, and the flag can be set by
          // hand afterwards. Reported so nobody assumes it landed.
          report.errors.push({ ...student, stage: 'boughtOut-flag', error: reason })
        }
      } catch (error) {
        report.errors.push({ ...student, stage: 'boughtOut-flag', error: error.message })
      }
    }

    try {
      const result = await createBuyOutInvoiceFn(contract, items, documentType, invoiceCreatedBy, {
        rateStatusOnInvoice: RATE_STATUS_BY_MODE[mode],
        invoiceLineLabel: INVOICE_LINE_LABEL_BY_MODE[mode]
      })
      if (result.status !== 200) {
        // createBuyOutInvoice bails mid-loop on a failed rate write, so the contract may be partly
        // updated - it says so itself. Recorded and moved past; one bad contract must not end the run.
        logger('error', [logPrefix, `createBuyOutInvoice feilet for kontrakt ${student.contractId} (fnr: ${maskFnr(fnr)}): ${result.status} ${result.body}`])
        report.errors.push({ ...student, stage: 'createBuyOutInvoice', error: result.body, status: result.status })
        continue
      }
      report.invoiced.push(invoicedEntry)
    } catch (error) {
      logger('error', [logPrefix, `Uventet feil ved fakturering av kontrakt ${student.contractId} (fnr: ${maskFnr(fnr)})`, error.message])
      report.errors.push({ ...student, stage: 'createBuyOutInvoice', error: error.message })
    }
  }

  report.totals = {
    contracts: report.invoiced.length,
    rates: report.invoiced.reduce((count, entry) => count + entry.rates.length, 0),
    sum: report.invoiced.reduce((sum, entry) => sum + entry.total, 0)
  }

  logger('info', [logPrefix, `${dryRun ? '[DRY RUN] Ville fakturert' : 'Fakturerte'} ${report.totals.contracts} kontrakt(er) / ${report.totals.rates} rate(r), sum ${report.totals.sum}. Hoppet over: ${report.skipped.length}, flere treff: ${report.multiMatch.length}, ikke funnet: ${report.notFound.length}, feil: ${report.errors.length}`])

  return report
}

module.exports = {
  bulkInvoiceFromFile,
  detectFnrColumn,
  normalizeStudentFnr,
  looksLikeScientificNotation,
  selectRatesToInvoice,
  findContractDefect,
  CANDIDATE_COLLECTIONS,
  MODES,
  RATE_STATUS_BY_MODE,
  INVOICE_LINE_LABEL_BY_MODE,
  FNR_COLUMN_CANDIDATES
}
