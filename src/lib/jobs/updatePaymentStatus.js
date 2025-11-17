/**
 * This Job checks billed contracts against xLedger to see if they have been payed, and if so. updates the DB
 * Steps:
 * 1. Query mongoDB for all contracts that have a løpenummer staring with "JOTN-" but not a status that is "Betalt" or "Utlån faktureres ikke"
 * 2. Bundle up theese in chuncks of 100, and checks them against xledger API based on the 'løpenummer'
 * 3. If Xledger status now is payed, we update our DB with correct status
 */


const { getDocuments, updateDocument } = require('./queryMongoDB.js');
const { getSalesOrders, getOrderStatuses } = require('./queryXledger.js');
const { logger } = require('@vtfk/logger');
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
  gamleRates: 'Gamle løpenummer',
})

/**
 * 
 * @param {string} rateName 
 * @returns {Object}
 */
function addQueryRate(rateName) {
  const array = [{}, {}, {}]
  array[0]["fakturaInfo." + rateName + ".løpenummer"] = { '$not': { '$in': [RateStatus.ukjent, null] } }
  array[1]["fakturaInfo." + rateName + ".status"] = { '$not': { '$in': [RateStatus.betalt, RateStatus.utlaan, RateStatus.ikkeBetale, RateStatus.kreditert] } }
  array[2]["fakturaInfo." + rateName + ".faktureringsDato"] = { '$gt': "2025-10-01T00:00:00.000Z" }
  return {
    '$and': array
  }
}

/**
 * 
 * @returns {Object}
 */
async function fecthContractCandidatesFromMongoDB() {
  const query = {
    '$or': [
      addQueryRate('rate1'),
      addQueryRate('rate2'),
      addQueryRate('rate3'),
    ]
  }
  return await getDocuments(query, 'regular')
}

/**
 * 
 * @param {Object} rate 
 * @returns {boolean}
 */
function checkRateCandidacy(rate) {
  // Ingen løpenummer betyr at vi ikke har fakturert ennå, så vi kan returnere med det samme.
  if (!rate.løpenummer)
    return false

  if (rate.løpenummer.substring(0, 4) === 'JOT-' && (rate.status === RateStatus.fakturert || rate.status === RateStatus.ukjent || rate.status === RateStatus.inkasso))
    return true

  return false
}


/**
 * 
 * @param {string} key 
 * @param {Object} summary  
 */
function addToSummary(key, summary) {
  if (!summary[key]) {
    summary[key] = 0
  }
  summary[key]++
}


async function updateMongo(documentId, rateKey, status) {
  const updateData = {}
  updateData['fakturaInfo.' + rateKey + '.status'] = status

  // IKKE uncomment dette før vi VET vi skal i prod
  await updateDocument(documentId, updateData, 'regular')
}


/**
 * 
 * @param {Array} xLedgerRows 
 * @param {Object} ratesDictionary 
 * @param {Object} summary
 * @returns {number}
 */
async function updateDictionaryWithResponse(xLedgerRows, ratesDictionary, summary) {
  xLedgerRows.forEach(async (row) => {
    const dictionaryEntry = ratesDictionary[row.extOrderNumber]
    dictionaryEntry.salesOrders.push(row)
    if (row.status === RateStatus.betalt || row.status === RateStatus.kreditert) {
      await updateMongo(dictionaryEntry.contract._id, dictionaryEntry.rateKey, row.status)
    }

    addToSummary(row.status, summary)
  })
}

// For å se om denne raten er en kandidat for å sjekke opp imot xledger
const updatePaymentStatus = async () => {
  try {
    const documents = await fecthContractCandidatesFromMongoDB()
    const targetChunckSize = 400;
    let ratesToCheck = []
    let ratesDictionary = {}
    const summary = {
      'Totalt antall i database': documents.result.length,
      multiRateHits: 0
    }

    for (let index = 0; index < documents.result.length; index++) {
      const lastIndex = documents.result.length - 1;
      const contract = documents.result[index];
      let hits = 0;
      for (const [key, rate] of Object.entries(contract.fakturaInfo)) {
        if (checkRateCandidacy(rate)) {
          hits++
          ratesToCheck.push(rate.løpenummer)
          ratesDictionary[rate.løpenummer] = { rate: rate, contract: contract, rateKey: key, salesOrders: [] }
        }
      }
      if (hits < 1) {
        /* Her dukker typisk ting som har løpenummer av gammel type (Digitroll) opp. De kommer i databasespørringen, men har løpenummer som ikke starter med "JOT-" */
        addToSummary(ExtendedSummaryStatus.gamleRates, summary)
      } else if (hits > 1) {
        summary.multiRateHits++;
      }

      // Handle a chunk of invoices
      if (ratesToCheck.length >= targetChunckSize || index === lastIndex) {
        const orderStatusRows = await getOrderStatuses(ratesToCheck)
        await updateDictionaryWithResponse(orderStatusRows, ratesDictionary, summary)
        ratesToCheck = []
        ratesDictionary = {}
      }
    }
/*
    // We need to handle the leftover items to...
    const xledgerRows = await getOrderStatuses(ratesToCheck)
    await updateDictionaryWithResponse(xledgerRows, ratesDictionary, summary)
*/
    return summary
  }
  catch (error) {
    logger('error', [logPrefix, 'Error updating paymentStatus', error])
  }
}

module.exports = {
  updatePaymentStatus,
}