'use strict'

const { mongoDB } = require('../../../config')
const { getBillingYear } = require('../documentSchema.js')

/**
 * Checks whether an active contract of the same type already exists for the student
 * in either the 'kontrakter' or 'historiske-avtaler-pc-ikke-innlevert' collection.
 * @param {string} fnr - Student national ID number
 * @param {string} kontraktType - Contract type (e.g. "Leieavtale" or "Låneavtale")
 * @param {import('mongodb').MongoClient} mongoClient
 * @returns {Promise<boolean>}
 */
const checkIsDuplicate = async (fnr, kontraktType, mongoClient) => {
  const query = { 'elevInfo.fnr': fnr, 'unSignedskjemaInfo.kontraktType': kontraktType }
  const [inKontrakter, inPcIkkeInnlevert] = await Promise.all([
    mongoClient.db(mongoDB.dbName).collection(mongoDB.contractsCollection).findOne(query),
    mongoClient.db(mongoDB.dbName).collection(mongoDB.historicPcNotDeliveredCollection).findOne(query)
  ])
  return inKontrakter !== null || inPcIkkeInnlevert !== null
}

/**
 * Finds the most recent historical contract for a student in 'historiske-avtaler'.
 * @param {string} fnr - Student national ID number
 * @param {import('mongodb').MongoClient} mongoClient
 * @returns {Promise<Object|null>}
 */
const findLatestHistoricalContract = async (fnr, mongoClient) => {
  const result = await mongoClient
    .db(mongoDB.dbName)
    .collection(mongoDB.historicCollection)
    .find({ 'elevInfo.fnr': fnr })
    .sort({ generatedTimeStamp: -1 })
    .limit(1)
    .toArray()
  return result.length > 0 ? result[0] : null
}

/**
 * Copies fakturaInfo from a historical contract onto the new document.
 * For each rate where status is 'Ikke Fakturert', recalculates faktureringsår
 * based on the current date so the new contract has the correct billing years.
 * @param {Object} document - New contract document
 * @param {Object} historicalContract - Historical contract to copy fakturaInfo from
 * @returns {Object} - Updated document with merged fakturaInfo
 */
const applyHistoricalFakturaInfo = (document, historicalContract) => {
  if (!historicalContract?.fakturaInfo) return document
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

module.exports = {
  checkIsDuplicate,
  findLatestHistoricalContract,
  applyHistoricalFakturaInfo
}
