/**
 * This Job checks billed contracts against xLedger to see if they have been payed, and if so. updates the DB
 * Steps:
 * 1. Query mongoDB for all contracts that have a løpenummer staring with "JOTN-" but not a status that is "Betalt" or "Utlån faktureres ikke"
 * 2. Bundle up theese in chuncks of 100, and checks them against xledger API based on the 'løpenummer'
 * 3. If Xledger status now is payed, we update our DB with correct status
 */

const { getDocuments, updateDocument } = require('./queryMongoDB.js')
const { getSalesOrders, getOrderStatuses } = require('./queryXledger.js')
const { logger } = require('@vtfk/logger')
const logPrefix = 'updatePaymentStatus'

// Primitiv enum substitutt
const RateStatus = Object.freeze({
  utlaan: 'Utlån faktureres ikke',
  betalt: 'Betalt',
  inkasso: 'Overført inkasso',
  ukjent: 'Ukjent',
  fakturert: 'Fakturert',
  ikkeBetale: 'Skal ikke betale',
  kreditert: 'Kreditert'
})

const ExtendedSummaryStatus = Object.freeze({
  ufakturert: 'Ufakturert',
  gamleRates: 'Gamle løpenummer'
})

/**
 *
 * @param {string} rateName
 * @returns {Object}
 */
function addQueryRate (rateName) {
  const array = [{}, {}, {}]
  array[0]['fakturaInfo.' + rateName + '.løpenummer'] = { $not: { $in: [RateStatus.ukjent, null] } }
  array[1]['fakturaInfo.' + rateName + '.status'] = { $not: { $in: [RateStatus.betalt, RateStatus.utlaan, RateStatus.ikkeBetale, RateStatus.kreditert] } }
  array[2]['fakturaInfo.' + rateName + '.faktureringsDato'] = { $gt: '2025-10-01T00:00:00.000Z' }
  return {
    $and: array
  }
}

/**
 *
 * @param {String} collection | ['regular', 'pcIkkeInnlevert', 'invoices']
 * @param {String} type | Only needed if collection is "invoices", to specify which type of invoices we are checking, e.g. "buyOut"
 * @returns {Object}
 */
async function fecthContractCandidatesFromMongoDB (collection, type) {
  if(collection === 'regular' || collection === 'pcIkkeInnlevert') {
    const query = {
      $or: [
        addQueryRate('rate1'),
        addQueryRate('rate2'),
        addQueryRate('rate3')
      ]
    }
    return await getDocuments(query, collection)
  }

  if(collection === 'invoices' && type === 'buyOut') {
    const query = {
      type: { $in: ['buyOut'] },
      rates: { 
        $elemMatch: { status: { $not: { $in: [RateStatus.betalt, RateStatus.utlaan, RateStatus.ikkeBetale, RateStatus.kreditert] } }, 
        løpenummer: { $not: { $in: [RateStatus.ukjent, null] } } } }
    }
    return await getDocuments(query, collection)
  }

  if(collection === 'invoices' && type === 'extraInvoice') {
    const query = {
      type: { $in: ['extraInvoice'] },
      status: { $not: { $in: [RateStatus.betalt, RateStatus.utlaan, RateStatus.ikkeBetale, RateStatus.kreditert] } }, 
      løpenummer: { $not: { $in: [RateStatus.ukjent, null] } }
    }
    return await getDocuments(query, collection)
  }
}

/**
 *
 * @param {Object} rate
 * @returns {boolean}
 */
function checkRateCandidacy (rate) {
  // Ingen løpenummer betyr at vi ikke har fakturert ennå, så vi kan returnere med det samme.
  if (!rate.løpenummer) { return false }

  if (rate.løpenummer.substring(0, 4) === 'JOT-' && (rate.status === RateStatus.fakturert || rate.status === RateStatus.ukjent || rate.status === RateStatus.inkasso)) { return true }

  return false
}

/**
 *
 * @param {string} key
 * @param {Object} summary
 */
function addToSummary (key, summary) {
  if (!summary[key]) {
    summary[key] = 0
  }
  summary[key]++
}

async function updateMongo (documentId, rateKey, status, collection, type) {
  if((collection === 'regular' || collection === 'pcIkkeInnlevert') && type === undefined) {
    const updateData = {}

    updateData['fakturaInfo.' + rateKey + '.status'] = status
    updateData['fakturaInfo.' + rateKey + '.betaltDato'] = new Date().toISOString()

    await updateDocument(documentId, updateData, collection)
  }

  if(collection === 'invoices' && type === 'buyOut') {
    const updateData = {}

    updateData['itemsFromCart.' + rateKey + '.status'] = status
    updateData['itemsFromCart.' + rateKey + '.betaltDato'] = new Date().toISOString()
    updateData['rates.' + rateKey + '.status'] = status
    updateData['rates.' + rateKey + '.betaltDato'] = new Date().toISOString()

    await updateDocument(documentId, updateData, collection)
  }

  if(collection === 'invoices' && type === 'extraInvoice') {
    const updateData = {}

    updateData['status'] = status
    updateData['betaltDato'] = new Date().toISOString()

    await updateDocument(documentId, updateData, collection)
  }
}

/**
 *
 * @param {Array} xLedgerRows
 * @param {Object} ratesDictionary
 * @param {Object} summary
 * @returns {number}
 */
async function updateDictionaryWithResponse (xLedgerRows, ratesDictionary, summary, collection, type) {
  if(type === undefined || type === 'buyOut') {
    xLedgerRows.forEach(async (row) => {
      const dictionaryEntry = ratesDictionary[row.extOrderNumber]
      dictionaryEntry.salesOrders.push(row)
      if (row.status === RateStatus.betalt || row.status === RateStatus.kreditert) {
        await updateMongo(dictionaryEntry.contract._id, dictionaryEntry.rateKey, row.status, collection, type)
      }
      addToSummary(row.status, summary)
    })
  }

  if(type === 'extraInvoice') {
    xLedgerRows.forEach(async (row) => {
      const dictionaryEntry = ratesDictionary[row.extOrderNumber]
      dictionaryEntry.salesOrders.push(row)
      if (row.status === RateStatus.betalt || row.status === RateStatus.kreditert) {
        await updateMongo(dictionaryEntry.contract._id, dictionaryEntry.rateKey, row.status, collection, type)
      }
      addToSummary(row.status, summary)
    })
  }
}

// For å se om denne raten er en kandidat for å sjekke opp imot xledger
/**
 * @param {String} collection | ['regular', 'pcIkkeInnlevert', 'invoices'], avhengig av hvilken collection i MongoDB vi skal sjekke opp imot.
 * @returns 
 */
const updatePaymentStatus = async (collection, type) => {
  try {
    const documents = await fecthContractCandidatesFromMongoDB(collection, type)
    const targetChunckSize = 400
    let ratesToCheck = []
    let ratesDictionary = {}
    const summary = {
      'Totalt antall i database': documents.result.length,
      multiRateHits: 0
    }

    for (let index = 0; index < documents.result.length; index++) {
      const lastIndex = documents.result.length - 1
      const contract = documents.result[index]
      let hits = 0

      if(collection === 'regular' || collection === 'pcIkkeInnlevert') {
        for (const [key, rate] of Object.entries(contract.fakturaInfo)) {
          if (checkRateCandidacy(rate)) {
            hits++
            ratesToCheck.push(rate.løpenummer)
            ratesDictionary[rate.løpenummer] = { rate, contract, rateKey: key, salesOrders: [] }
          }
        }
      }

      if(collection === 'invoices' && type === 'buyOut') {
         for (const [i, rate] of contract.rates.entries()) {
          if (checkRateCandidacy(rate)) {
            hits++
            ratesToCheck.push(rate.løpenummer)
            ratesDictionary[rate.løpenummer] = { rate, contract, rateKey: i, salesOrders: [] }
          }
        }
      }

      if(collection === 'invoices' && type === 'extraInvoice') {
        if (checkRateCandidacy(contract)) {
          hits++
          ratesToCheck.push(contract.løpenummer)
          ratesDictionary[contract.løpenummer] = { rate: contract, contract, rateKey: null, salesOrders: [] }
        }
      }

      if (hits < 1) {
        /* Her dukker typisk ting som har løpenummer av gammel type (Digitroll) opp. De kommer i databasespørringen, men har løpenummer som ikke starter med "JOT-" */
        addToSummary(ExtendedSummaryStatus.gamleRates, summary)
      } else if (hits > 1) {
        console.log(`Document with id ${contract._id} has ${hits} rates with løpenummer, which means we will check the same document multiple times. This is not optimal, but we will handle it in the updateDictionaryWithResponse function to avoid updating the same document multiple times.`)
        summary.multiRateHits++
      }

      // Handle a chunk of invoices
      if (ratesToCheck.length >= targetChunckSize || index === lastIndex) {
        const orderStatusRows = await getOrderStatuses(ratesToCheck)
        await updateDictionaryWithResponse(orderStatusRows, ratesDictionary, summary, collection, type)
        ratesToCheck = []
        ratesDictionary = {}
      }
      /*
      // We need to handle the leftover items to...
      const xledgerRows = await getOrderStatuses(ratesToCheck)
      await updateDictionaryWithResponse(xledgerRows, ratesDictionary, summary, collection)
      */
    }
    return summary
  } catch (error) {
    logger('error', [logPrefix, 'Error updating paymentStatus', error])
  }
}

module.exports = {
  updatePaymentStatus
}
