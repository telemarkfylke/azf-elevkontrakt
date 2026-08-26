'use strict'

const { logger } = require('@vtfk/logger')
const { mongoDB } = require('../../../config')
const { getBillingYear } = require('../documentSchema.js')
const { maskFnr } = require('../helpers/maskFnr')

// kontraktType is matched case-insensitively since the same contract type has historically
// been stored with inconsistent casing (e.g. 'Leieavtale' vs 'leieavtale'), see also the
// $in: ['Leieavtale', 'leieavtale'] workarounds used across miscCleanUpJobs.js and xledgerInvoiceImport.js.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Checks whether an active contract of the same type already exists for the student
 * in either the 'kontrakter' or 'historiske-avtaler-pc-ikke-innlevert' collection.
 * @param {string} fnr - Student national ID number
 * @param {string} kontraktType - Contract type (e.g. "Leieavtale" or "Låneavtale")
 * @param {import('mongodb').MongoClient} mongoClient
 * @returns {Promise<boolean>}
 */
const checkIsDuplicate = async (fnr, kontraktType, mongoClient) => {
  const query = { 'elevInfo.fnr': fnr, 'unSignedskjemaInfo.kontraktType': { $regex: `^${escapeRegex(kontraktType)}$`, $options: 'i' } }
  const [inKontrakter, inPcIkkeInnlevert] = await Promise.all([
    mongoClient.db(mongoDB.dbName).collection(mongoDB.contractsCollection).findOne(query),
    mongoClient.db(mongoDB.dbName).collection(mongoDB.historicPcNotDeliveredCollection).findOne(query)
  ])
  return inKontrakter !== null || inPcIkkeInnlevert !== null
}

/**
 * Finds the most recent historical contract of the same kontraktType for a student in
 * 'historiske-avtaler'. Scoped to kontraktType (matched case-insensitively, same as
 * checkIsDuplicate) so a contract of one type never becomes a fakturaInfo merge source for a
 * contract of a different type (e.g. a "Låneavtale" must never seed a "Leieavtale"'s fakturaInfo).
 * @param {string} fnr - Student national ID number
 * @param {string} kontraktType - Contract type (e.g. "Leieavtale" or "Låneavtale")
 * @param {import('mongodb').MongoClient} mongoClient
 * @returns {Promise<Object|null>}
 */
const findLatestHistoricalContract = async (fnr, kontraktType, mongoClient) => {
  const result = await mongoClient
    .db(mongoDB.dbName)
    .collection(mongoDB.historicCollection)
    .find({ 'elevInfo.fnr': fnr, 'unSignedskjemaInfo.kontraktType': { $regex: `^${escapeRegex(kontraktType)}$`, $options: 'i' } })
    .sort({ generatedTimeStamp: -1 })
    .limit(1)
    .toArray()
  return result.length > 0 ? result[0] : null
}

/**
 * Copies fakturaInfo from a historical contract onto the new document.
 * For each rate where status is 'Ikke Fakturert', recalculates faktureringsår
 * based on the current date so the new contract has the correct billing years.
 *
 * Refuses to merge (returns document unchanged) if document and historicalContract have
 * different kontraktType (matched case-insensitively, same as checkIsDuplicate/
 * findLatestHistoricalContract) — a second, independent guard against the cross-type fakturaInfo
 * corruption bug (contractChecks.js, fixed 2026-08-19), in case findLatestHistoricalContract (or
 * some future caller) is ever given a mismatched historicalContract by mistake.
 *
 * Also skips the merge entirely for a Låneavtale: it is never invoiced, so there is no invoice
 * history to carry forward — its fakturaInfo is a constant ('Utlån faktureres ikke' on both status
 * and faktureringsår for all three rates), which fillDocument/fillManualDocument already produce.
 * Merging could therefore only ever import corruption, and did: Digitroll-imported Låneavtaler in
 * 'historiske-avtaler' carry a real faktureringsår (2025/2026/2027) alongside the correct status
 * (see handleFaktureringsårField, documentSchema.js), and this function copied that verbatim onto
 * new contracts — the year recalculation below only fires for 'Ikke Fakturert' rates — leaving them
 * to be rejected by getFakturaInfoMismatches.
 * @param {Object} document - New contract document
 * @param {Object} historicalContract - Historical contract to copy fakturaInfo from
 * @returns {Object} - Updated document with merged fakturaInfo
 */
const applyHistoricalFakturaInfo = (document, historicalContract) => {
  if (!historicalContract?.fakturaInfo) return document

  const documentKontraktType = document.unSignedskjemaInfo?.kontraktType?.toLowerCase()
  const historicalKontraktType = historicalContract.unSignedskjemaInfo?.kontraktType?.toLowerCase()
  if (documentKontraktType && historicalKontraktType && documentKontraktType !== historicalKontraktType) {
    logger('error', ['applyHistoricalFakturaInfo', 'Refusing to merge fakturaInfo across mismatched kontraktType', `fnr: ${maskFnr(document.elevInfo?.fnr)}`, `document kontraktType: ${documentKontraktType}`, `historicalContract kontraktType: ${historicalKontraktType}`])
    return document
  }

  if (documentKontraktType === 'låneavtale') {
    logger('info', ['applyHistoricalFakturaInfo', 'Låneavtale har ingen fakturahistorikk å arve, beholder fakturaInfo som den er', `fnr: ${maskFnr(document.elevInfo?.fnr)}`])
    return document
  }

  const rateKeys = ['rate1', 'rate2', 'rate3']
  const mergedFakturaInfo = {}
  let unpaidCount = 0
  rateKeys.forEach((key) => {
    const rate = { ...historicalContract.fakturaInfo[key] }
    if (rate.status === 'Ikke Fakturert') {
      unpaidCount++
      rate.faktureringsår = getBillingYear(unpaidCount)
    }
    mergedFakturaInfo[key] = rate
  })
  return { ...document, fakturaInfo: mergedFakturaInfo }
}

/**
 * Backfills signedSkjemaInfo/signedBy/isSigned on a document that is actually signed but never
 * had those fields populated (e.g. the signing update was lost because the document was
 * misfiled in duplicatesCollection at the time). Any document reaching 'kontrakter' is signed,
 * so isSigned is unconditionally set to 'true'; signedSkjemaInfo is copied from
 * unSignedskjemaInfo (both share the same shape); signedBy is copied from ansvarligInfo only
 * when ansvarligInfo was actually resolved (not the 'Ukjent' placeholder), otherwise left as-is.
 * @param {Object} document
 * @returns {Object} - New document object with signed fields backfilled
 */
const markAsSigned = (document) => {
  const ansvarligInfo = document.ansvarligInfo
  const ansvarligResolved = ansvarligInfo && ansvarligInfo.navn !== 'Ukjent' && ansvarligInfo.fnr !== 'Ukjent'
  return {
    ...document,
    isSigned: 'true',
    signedSkjemaInfo: { ...document.unSignedskjemaInfo },
    signedBy: ansvarligResolved ? { navn: ansvarligInfo.navn, fnr: ansvarligInfo.fnr } : document.signedBy
  }
}

/**
 * Checks a single fakturaInfo rate object against the invariant for the given kontraktType: a
 * Låneavtale rate must always have both status and faktureringsår set to 'Utlån faktureres ikke',
 * and a Leieavtale rate must never have either set to that value.
 * Returns null if the rate looks legitimate, or a short reason string if it doesn't.
 */
const checkRateAgainstKontraktType = (rate, normalizedKontraktType) => {
  if (!rate) return null
  if (normalizedKontraktType === 'låneavtale') {
    if (rate.status !== 'Utlån faktureres ikke') return `status is '${rate.status}', expected 'Utlån faktureres ikke'`
    if (rate.faktureringsår !== 'Utlån faktureres ikke') return `faktureringsår is '${rate.faktureringsår}', expected 'Utlån faktureres ikke'`
    return null
  }
  if (normalizedKontraktType === 'leieavtale') {
    if (rate.status === 'Utlån faktureres ikke') return "status is 'Utlån faktureres ikke', which a Leieavtale rate should never have"
    if (rate.faktureringsår === 'Utlån faktureres ikke') return "faktureringsår is 'Utlån faktureres ikke', which a Leieavtale rate should never have"
    return null
  }
  return null
}

/**
 * Checks a document's fakturaInfo.rate1/2/3 against the invariant for its kontraktType (see
 * checkRateAgainstKontraktType). Used both by the fakturaInfo/kontraktType mismatch audit
 * (findFakturaInfoTypeMismatches, miscCleanUpJobs.js) and as a final guard before a document is
 * ever written to 'kontrakter' (postFormInfo/postManualContract, queryMongoDB.js), so a mismatched
 * document can never be persisted silently regardless of how the mismatch happened.
 * @param {Object} document
 * @returns {Array<{rateKey: string, reason: string}>} - Empty if the document looks legitimate
 */
const getFakturaInfoMismatches = (document) => {
  const normalizedKontraktType = document.unSignedskjemaInfo?.kontraktType?.toLowerCase()
  if (normalizedKontraktType !== 'leieavtale' && normalizedKontraktType !== 'låneavtale') return []
  return ['rate1', 'rate2', 'rate3']
    .map(rateKey => ({ rateKey, reason: checkRateAgainstKontraktType(document.fakturaInfo?.[rateKey], normalizedKontraktType) }))
    .filter(({ reason }) => reason !== null)
}

const RETURNED_ALLOWED_RATE_STATUSES = ['Betalt', 'Skal ikke betale', 'Ikke Fakturert', 'Utlån faktureres ikke', 'Kreditert']
const BOUGHT_OUT_ALLOWED_RATE_STATUSES = ['Betalt', 'Skal ikke betale', 'Utlån faktureres ikke', 'Kreditert']

/**
 * Decides whether a contract should be archived to 'historic' or routed to 'pcIkkeInnlevert',
 * based on whether the PC was returned/bought out and whether all rates are in an accepted status
 * for that path. 'Fakturert' and 'Overført inkasso' (and any unrecognized status) always block
 * the move to 'historic', since they represent an unresolved invoice.
 * @param {Object} doc - Contract document with pcInfo and fakturaInfo
 * @returns {'historic'|'pcIkkeInnlevert'}
 */
const determineHistoryMoveTarget = (doc) => {
  const rates = [doc.fakturaInfo.rate1.status, doc.fakturaInfo.rate2.status, doc.fakturaInfo.rate3.status]
  const returnedRatesOk = rates.every(status => RETURNED_ALLOWED_RATE_STATUSES.includes(status))
  const boughtOutRatesOk = rates.every(status => BOUGHT_OUT_ALLOWED_RATE_STATUSES.includes(status))
  const shouldMoveToHistory =
    (doc.pcInfo.returned === 'true' && returnedRatesOk) ||
    (doc.pcInfo.boughtOut === 'true' && boughtOutRatesOk)
  return shouldMoveToHistory ? 'historic' : 'pcIkkeInnlevert'
}

module.exports = {
  checkIsDuplicate,
  findLatestHistoricalContract,
  applyHistoricalFakturaInfo,
  markAsSigned,
  determineHistoryMoveTarget,
  getFakturaInfoMismatches
}
