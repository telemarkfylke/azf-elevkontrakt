'use strict'

/**
 * Shared checks against the 'invoices' collection, used wherever a contract is about to be
 * archived to 'historiske-avtaler'.
 *
 * Why these exist separately from contractChecks.js: determineHistoryMoveTarget only ever sees a
 * contract's own fakturaInfo, and an extraInvoice (a damage charge, say) has no counterpart there
 * at all - so a contract can look completely settled by that rule while an unpaid invoice is
 * outstanding against it. Both archive paths consult these before moving anything:
 * updateStudentInfo.js (kontrakter -> historiske-avtaler) and archiveResolvedPcIkkeInnlevert.js
 * (historiske-avtaler-pc-ikke-innlevert -> historiske-avtaler).
 */

const { getDocuments } = require('./queryMongoDB')

const SETTLED_INVOICE_STATUSES = ['Betalt', 'Kreditert']

/**
 * An invoice is settled only when its top-level status *and* every rate is 'Betalt'/'Kreditert'.
 * Both halves matter: the top-level status is recomputed from rates[] only inside the manual
 * repairBuyOutInvoiceStatuses job, so a buyOut invoice's top-level value can be stale. An
 * extraInvoice carries rates: [], so it is decided by its top-level status alone.
 */
const isInvoiceSettled = (invoice) =>
  SETTLED_INVOICE_STATUSES.includes(invoice.status) &&
  (invoice.rates ?? []).every(rate => SETTLED_INVOICE_STATUSES.includes(rate.status))

/**
 * The shape invoices are reported and logged in - enough to explain why a contract was held back
 * without dumping the whole invoice document.
 */
const describeInvoice = (invoice) => ({
  invoiceId: invoice._id.toString(),
  type: invoice.type,
  status: invoice.status,
  rateStatuses: (invoice.rates ?? []).map(rate => rate.status)
})

/**
 * customerContractId is written as the raw ObjectId (processInvoices.js), so that is the expected
 * form, but the string form is matched too: a missed invoice would mean wrongly archiving a
 * contract that still owes money, and a two-element-per-id $in costs nothing.
 */
const invoiceQueryForContractIds = (contractIds) => ({
  customerContractId: { $in: [...contractIds, ...contractIds.map(id => String(id))] }
})

/**
 * Fetches every invoice belonging to the given contracts in one round-trip and groups them by
 * contract id - the bulk pre-filter pattern from syncPureserviceAssetLifecycle, rather than one
 * query per candidate. For a single contract, prefer getUnsettledInvoices.
 * @param {Array<Object>} contracts - contract documents (only _id is read)
 * @param {Function} [getDocumentsFn]
 * @returns {Promise<Map<string, Array<Object>>>} - keyed by String(contract._id)
 */
const fetchInvoicesByContract = async (contracts, getDocumentsFn = getDocuments) => {
  const invoicesByContract = new Map()
  if (contracts.length === 0) return invoicesByContract

  const result = await getDocumentsFn(invoiceQueryForContractIds(contracts.map(doc => doc._id)), 'invoices')

  // 404 = no invoices for any of these contracts, which just makes the caller's gate a no-op
  if (result.status !== 200 || !result.result?.length) return invoicesByContract

  for (const invoice of result.result) {
    const key = String(invoice.customerContractId)
    if (!invoicesByContract.has(key)) invoicesByContract.set(key, [])
    invoicesByContract.get(key).push(invoice)
  }
  return invoicesByContract
}

/**
 * The unsettled invoices for one contract, empty when it has none. For callers that only reach
 * the archive decision for a handful of documents per run (updateStudentInfo), one query at that
 * point is far cheaper than pre-fetching invoices for the whole collection.
 * @param {*} contractId - contract _id (ObjectId or string)
 * @param {Object} [deps]
 * @param {Function} [deps.getDocumentsFn]
 * @returns {Promise<Array<Object>>}
 */
const getUnsettledInvoices = async (contractId, deps = {}) => {
  const { getDocumentsFn = getDocuments } = deps
  const result = await getDocumentsFn(invoiceQueryForContractIds([contractId]), 'invoices')
  if (result.status !== 200 || !result.result?.length) return []
  return result.result.filter(invoice => !isInvoiceSettled(invoice))
}

module.exports = {
  SETTLED_INVOICE_STATUSES,
  isInvoiceSettled,
  describeInvoice,
  fetchInvoicesByContract,
  getUnsettledInvoices
}
