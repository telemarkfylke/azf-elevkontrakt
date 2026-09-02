'use strict'

const { logger } = require('@vtfk/logger')
const { getDocuments, updateContractPCStatus } = require('./queryMongoDB')

const VALID_STATUSES = ['innlevering', 'utkjøp', 'utlevering']

const STATUS_FIELD_MAP = {
  utlevering: 'releasePC',
  innlevering: 'returnPC',
  utkjøp: 'buyOutPC'
}

/**
 * Looks up a contract by Pureservice user ID — checks active contracts ('regular') first,
 * then the historic PC-not-delivered collection ('pcIkkeInnlevert'). Does not throw; returns
 * { contract: null, documentType: null } when nothing matches, leaving error handling to the
 * caller (updatePCStatus throws a 404, other callers may prefer to skip and log).
 * If more than one contract matches the same pureserviceId (e.g. a student with both an active
 * Leieavtale and Låneavtale), the first result is used - not disambiguated further.
 * @param {number} pureserviceId
 * @param {Object} [deps]
 * @param {Function} [deps.getDocumentsFn]
 * @returns {Promise<{contract: Object|null, documentType: 'regular'|'pcIkkeInnlevert'|null}>}
 */
const findContractByPureserviceId = async (pureserviceId, deps = {}) => {
  const { getDocumentsFn = getDocuments } = deps

  const regularResult = await getDocumentsFn({ pureserviceId }, 'regular')
  if (regularResult.status === 200) {
    return { contract: regularResult.result[0], documentType: 'regular' }
  }

  const historicResult = await getDocumentsFn({ pureserviceId }, 'pcIkkeInnlevert')
  if (historicResult.status === 200) {
    return { contract: historicResult.result[0], documentType: 'pcIkkeInnlevert' }
  }

  return { contract: null, documentType: null }
}

/**
 * Maps a documentType from findContractByPureserviceId to the targetCollection value
 * updateContractPCStatus expects: undefined for the regular contracts collection,
 * 'pcIkkeInnlevert' for the historic PC-not-delivered collection.
 * @param {'regular'|'pcIkkeInnlevert'|null} documentType
 */
const targetCollectionFor = (documentType) => documentType === 'pcIkkeInnlevert' ? 'pcIkkeInnlevert' : undefined

const updatePCStatus = async (studentId, newStatus, requestMadeBy, deps = {}) => {
  const logPrefix = 'updatePCStatus'
  const {
    getDocumentsFn = getDocuments,
    updateContractPCStatusFn = updateContractPCStatus
  } = deps

  const normalizedStatus = newStatus.toLowerCase().trim()

  if (!VALID_STATUSES.includes(normalizedStatus)) {
    const err = new Error(`Invalid newStatus '${newStatus}'. Must be one of: ${VALID_STATUSES.join(', ')}`)
    err.status = 400
    throw err
  }

  // pureserviceId is stored as Int32 in MongoDB — parse to integer so the driver
  // serializes the query value with the correct BSON type
  const pureserviceId = parseInt(studentId, 10)
  if (isNaN(pureserviceId)) {
    const err = new Error(`Invalid studentId '${studentId}' — must be a numeric Pureservice ID`)
    err.status = 400
    throw err
  }

  const { contract, documentType } = await findContractByPureserviceId(pureserviceId, { getDocumentsFn })

  if (!contract) {
    logger('error', [logPrefix, `No contract found for studentId/pureserviceId: ${studentId}, requestMadeBy: ${requestMadeBy}`])
    const err = new Error(`No contract found for studentId/pureserviceId: ${studentId}, requestMadeBy: ${requestMadeBy}`)
    err.status = 404
    throw err
  }

  logger('info', [logPrefix, `Found contract in ${documentType === 'pcIkkeInnlevert' ? 'historiske-avtaler-pc-ikke-innlevert' : 'kontrakter'} for pureserviceId: ${studentId}`])

  const contractUpdate = {
    contractID: contract._id.toString(),
    [STATUS_FIELD_MAP[normalizedStatus]]: 'true',
    upn: requestMadeBy || 'pureservice'
  }

  logger('info', [logPrefix, `Updating pcInfo for contractID: ${contractUpdate.contractID}, status: ${normalizedStatus}, upn: ${contractUpdate.upn}`])

  const result = await updateContractPCStatusFn(contractUpdate, false, targetCollectionFor(documentType))
  return result
}

module.exports = { updatePCStatus, findContractByPureserviceId, targetCollectionFor }
