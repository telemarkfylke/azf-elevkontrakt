'use strict'

/**
 * Resolving a contract to the collection it actually lives in, rather than trusting a stored
 * pointer.
 *
 * A contract moves between 'kontrakter', 'historiske-avtaler-pc-ikke-innlevert' and
 * 'historiske-avtaler' over its life (see docs/pc-ikke-innlevert-lifecycle.md), and
 * moveAndDeleteDocument preserves its _id across every move. An invoice's
 * mainDocumentCollectionSource records where the contract lived when the invoice was created and is
 * maintained on each move, but it is a *hint*: anything about to write to the contract must resolve
 * the collection here first. Trusting the stored value silently wrote rate updates into
 * 'kontrakter' for contracts that had since been archived, which stranded them - the rate never got
 * its løpenummer, so no payment sweep could ever match it.
 *
 * Lives in its own leaf module because queryMongoDB.js already requires contractChecks.js, so a
 * getDocuments-dependent helper there would be a require cycle.
 */

const { ObjectId } = require('mongodb')
const { logger } = require('@vtfk/logger')
const { getDocuments } = require('./queryMongoDB')

/**
 * The collections a contract document can legitimately live in, in the order they are searched.
 * 'regular' first because it is by far the common case - and because it is the right precedence if
 * a partial move (insert succeeded, delete failed) ever left copies in two collections.
 */
const CONTRACT_DOCUMENT_TYPES = ['regular', 'pcIkkeInnlevert', 'history']

/**
 * Looks up a contract by _id across all three contract collections. Mirrors
 * findContractByPureserviceId (updatePCStatus.js): does not throw, and returns
 * { contract: null, documentType: null } when nothing matches, leaving error handling to the caller.
 *
 * Unlike that function this one must guard the id: new ObjectId() raises a BSONError on a malformed
 * string, and callers rely on this returning rather than throwing so they can carry on with the
 * rest of their work.
 * @param {import('mongodb').ObjectId|string} contractId
 * @param {Object} [deps]
 * @param {Function} [deps.getDocumentsFn]
 * @returns {Promise<{contract: Object|null, documentType: 'regular'|'pcIkkeInnlevert'|'history'|null}>}
 */
const findContractById = async (contractId, deps = {}) => {
  const { getDocumentsFn = getDocuments } = deps
  const logPrefix = 'findContractById'

  if (!contractId || !ObjectId.isValid(contractId)) {
    logger('error', [logPrefix, `Ugyldig contractId: ${contractId}`])
    return { contract: null, documentType: null }
  }

  const query = { _id: new ObjectId(contractId) }

  for (const documentType of CONTRACT_DOCUMENT_TYPES) {
    // Positive test on 200: getDocuments answers 404 for an empty result and 400 for an invalid
    // documentType, and both must fall through to the next collection rather than abort the search.
    const result = await getDocumentsFn(query, documentType)
    if (result.status === 200 && result.result?.length > 0) {
      return { contract: result.result[0], documentType }
    }
  }

  return { contract: null, documentType: null }
}

/**
 * updateDocument returns the raw Mongo result and never signals a miss, so an update against the
 * wrong collection is a silent no-op. Every contract write that resolves its collection at runtime
 * runs its result through here, so "did it actually land" is one call rather than a copy-pasted
 * matchedCount check that the next call site forgets.
 * @param {Object} result - whatever updateDocument returned
 * @param {String} context - included verbatim in the log line
 * @returns {{updated: boolean, reason: string|null}}
 */
const assertContractUpdated = (result, context) => {
  if (result?.status && result.status !== 200) {
    logger('error', ['assertContractUpdated', `${context}: updateDocument avviste kallet`, JSON.stringify(result)])
    return { updated: false, reason: result.error || `updateDocument returnerte status ${result.status}` }
  }
  if (result?.matchedCount === 0) {
    logger('error', ['assertContractUpdated', `${context}: ingen kontrakt matchet - oppdateringen traff ingenting`])
    return { updated: false, reason: 'Ingen kontrakt matchet _id i den oppgitte collection (matchedCount 0)' }
  }
  return { updated: true, reason: null }
}

module.exports = {
  findContractById,
  assertContractUpdated,
  CONTRACT_DOCUMENT_TYPES
}
