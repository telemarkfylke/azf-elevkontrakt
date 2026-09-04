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

module.exports = {
  isRecipientImportedToXledger
}
