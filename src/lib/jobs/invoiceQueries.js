'use strict'

/**
 * Query builders for the 'invoices' collection.
 *
 * Deliberately dependency-free: both invoiceChecks.js and queryMongoDB.js need
 * invoiceQueryForContractIds, and invoiceChecks.js already requires queryMongoDB.js. Building the
 * query inside either of those would make the other require it back, and since both destructure
 * their imports at module top level that cycle *fails* rather than warns - whichever module loaded
 * second would see `{}` and blow up at call time. Keeping the builders in a leaf both can import
 * removes the possibility.
 */

const { ObjectId } = require('mongodb')

/**
 * customerContractId is written as the raw ObjectId (processInvoices.js), so that is the expected
 * form, but the string form is matched too: a missed invoice would mean wrongly archiving a
 * contract that still owes money, and a two-element-per-id $in costs nothing.
 *
 * Both forms are derived here rather than left to the caller. Callers are genuinely inconsistent
 * about the type - the jobs pass `doc._id` (an ObjectId) while handleDbRequest passes
 * `jsonBody.contractID` (a string off the wire) - and a plain string passed straight through would
 * produce two strings and match a stored ObjectId not at all. Getting that wrong fails *open*: the
 * archive gate would find no unsettled invoices and wave the contract through, which is the one
 * outcome it exists to prevent. So normalize in one place instead of trusting six call sites.
 * @param {Array<import('mongodb').ObjectId|string>} contractIds
 */
const invoiceQueryForContractIds = (contractIds) => {
  const forms = new Set()
  for (const id of contractIds) {
    forms.add(String(id))
  }
  const objectIds = [...forms].filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id))
  return { customerContractId: { $in: [...objectIds, ...forms] } }
}

module.exports = {
  invoiceQueryForContractIds
}
