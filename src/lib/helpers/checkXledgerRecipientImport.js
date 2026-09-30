/**
 * Whether the contract's responsible person (ansvarligInfo - the party that gets invoiced) has been
 * imported to Xledger as a customer.
 *
 * The flag lives on the contract and is written in two different shapes: documentSchema.js sets the
 * *string* 'false' when a contract is created, while xledgerUserImport.js/xledgerResetUserImportStatus.js
 * write *booleans*. Accepting both `true` and 'true' is therefore a requirement, not defensiveness -
 * and a contract still holding the string 'false' must not read as imported just because the string
 * is truthy.
 *
 * Invoicing a recipient that is not in Xledger yet leaves the invoice pointing at an unknown
 * subledger account, which somebody has to create by hand. Anything that is not clearly `true` is
 * treated as not imported.
 *
 * @param {Object} contract | A contract document (from 'kontrakter', 'historiske-avtaler-pc-ikke-innlevert' or 'historiske-avtaler')
 * @returns {Boolean} | True only when isImportedToXledger is boolean true or the string 'true'
 */
const isRecipientImportedToXledger = (contract) => {
  const value = contract?.isImportedToXledger
  if (value === true) return true
  return typeof value === 'string' && value.toLowerCase() === 'true'
}

// Days a recipient must have been in Xledger before we send an invoice to it. Used by both invoice runs.
const XLEDGER_SETTLE_DAYS = 7

/**
 * Whether the recipient was imported to Xledger at least XLEDGER_SETTLE_DAYS ago.
 * Only a real date counts - a missing value or 'Ukjent' is not settled.
 * @param {Object} contract | A contract document
 * @param {Number} [now] | Epoch ms, for tests
 * @param {Number} [days]
 * @returns {Boolean}
 */
const hasRecipientSettledInXledger = (contract, now = Date.now(), days = XLEDGER_SETTLE_DAYS) => {
  const value = contract?.importedToXledgerAt
  if (!(value instanceof Date) && typeof value !== 'string') return false
  const importedAt = new Date(value).getTime()
  if (!Number.isFinite(importedAt)) return false
  return importedAt <= now - days * 24 * 60 * 60 * 1000
}

module.exports = {
  isRecipientImportedToXledger,
  hasRecipientSettledInXledger,
  XLEDGER_SETTLE_DAYS
}
