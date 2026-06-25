'use strict'

const { logger } = require('@vtfk/logger')
const { getDocuments, updateContractPCStatus } = require('./queryMongoDB')

const VALID_STATUSES = ['innlevering', 'utkjøp', 'utlevering']

const STATUS_FIELD_MAP = {
  utlevering: 'releasePC',
  innlevering: 'returnPC',
  utkjøp: 'buyOutPC'
}

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

  // Look up contract by pureserviceId — check active contracts first, then historic
  let contract = null
  let targetCollection

  const regularResult = await getDocumentsFn({ pureserviceId }, 'regular')
  if (regularResult.status === 200) {
    contract = regularResult.result[0]
    logger('info', [logPrefix, `Found contract in kontrakter for pureserviceId: ${studentId}`])
  } else {
    const historicResult = await getDocumentsFn({ pureserviceId }, 'pcIkkeInnlevert')
    if (historicResult.status === 200) {
      contract = historicResult.result[0]
      targetCollection = 'pcIkkeInnlevert'
      logger('info', [logPrefix, `Found contract in historiske-avtaler-pc-ikke-innlevert for pureserviceId: ${studentId}`])
    }
  }

  if (!contract) {
    logger('error', [logPrefix, `No contract found for studentId/pureserviceId: ${studentId}`])
    const err = new Error(`No contract found for studentId/pureserviceId: ${studentId}`)
    err.status = 404
    throw err
  }

  const contractUpdate = {
    contractID: contract._id.toString(),
    [STATUS_FIELD_MAP[normalizedStatus]]: 'true',
    upn: requestMadeBy || 'pureservice'
  }

  logger('info', [logPrefix, `Updating pcInfo for contractID: ${contractUpdate.contractID}, status: ${normalizedStatus}, upn: ${contractUpdate.upn}`])

  const result = await updateContractPCStatusFn(contractUpdate, false, targetCollection)
  return result
}

module.exports = { updatePCStatus }
