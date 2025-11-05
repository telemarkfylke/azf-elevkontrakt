/**
 * This Job checks billed contracts against xLedger to see if they have been payed, and if so. updates the DB
 * Steps:
 * 1. Query mongoDB for all contracts that have a løpenummer staring with "JOTN-" but not a status that is "Betalt" or "Utlån faktureres ikke"
 * 2. Bundle up theese in chuncks of 100, and checks them against xledger API based on the 'løpenummer'
 * 3. If Xledger status now is payed, we update our DB with correct status
 */


const { getDocuments, updateDocument } = require('../jobs/queryMongoDB.js');
const { getSalesOrders } = require('./queryXLedger.js');

// Primitiv enum substitutt
const RateStatus = {
  utlaan: 'Utlån faktureres ikke',
  betalt: 'Betalt',
  inkasso: 'Overført inkasso',
  ukjent: 'Ukjent',
  fakturert: 'Fakturert',
  ikkeBetale: 'Skal ikke betale',
  kreditert: 'Kreditert',

  ufakturert: 'Ikke fakturert'
}

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
 * @param {Object} dictionaryEntry 
 * @returns {number}
 */
async function compareAndUpdateStatus(dictionaryEntry) {

  if (dictionaryEntry.salesOrders.length === 0) {
    // Her ligger det løpenummer i Jotne uten matchende salgsordrer, importfil er generert, men ikke importert
    return RateStatus.ufakturert
  }

  let invoiceAmountSum = 0;
  let remainingAmountSum = 0;
  for (let i = 0; i < dictionaryEntry.salesOrders.length; i++) {
    invoiceAmountSum += dictionaryEntry.salesOrders[i].invoiceAmount
    remainingAmountSum += dictionaryEntry.salesOrders[i].remainingAmount
  }

  if (invoiceAmountSum <= 0) {
    // Kreditert  
    await updateMongo(dictionaryEntry.contract._id, dictionaryEntry.rateKey, RateStatus.kreditert)
    return RateStatus.kreditert
  }
  else if (remainingAmountSum == 0) {
    // Betalt
    await updateMongo(dictionaryEntry.contract._id, dictionaryEntry.rateKey, RateStatus.betalt)
    return RateStatus.betalt
  }
  else if (remainingAmountSum > 0) {
    // Ikke betalt
    return RateStatus.fakturert
  }

  return RateStatus.ukjent
}

async function updateMongo(documentId, rateKey, status) {
  const updateData = {}
  updateData['fakturaInfo.' + rateKey + '.status'] = status

  // IKKE uncomment dette før vi VET vi skal i prod
  //await updateDocument(documentId, updateData, 'regular')
}


/**
 * 
 * @param {Array} xLedgerRows 
 * @param {Object} ratesDictionary 
 * @returns {number}
 */
async function updateDictionaryWithResponse(xLedgerRows, ratesDictionary, statistics) {
  let updates = 0;

  // Sørge for å samle alle salgsordrer på samme extInvoceNr sammen, slik at vi kan tolke dem
  xLedgerRows.forEach(async (row) => {
    const dictionaryEntry = ratesDictionary[row.extOrderNumber]
    dictionaryEntry.salesOrders.push(row)
  })

  // Nå som de er samlet, kan vi vurder internt på et nummer om det er betalt elelr kreditert o.s.v.
  for (const dictionaryEntry of Object.values(ratesDictionary)) {
    const status = (await compareAndUpdateStatus(dictionaryEntry))

    if (!statistics[status]) {
      statistics[status] = 0
    }
    statistics[status]++


  }

  return updates
}

// For å se om denne raten er en kandidat for å sjekke opp imot xledger
const updatePaymentStatus = async () => {
  try {
    const documents = await fecthContractCandidatesFromMongoDB()
    let multihits = 0;
    let noHits = 0;
    const targetChunckSize = 400;
    let ratesToCheck = []
    let ratesDictionary = {}
    const statistics = {}

    for (let index = 0; index < documents.result.length; index++) {
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
        noHits++
      } else if (hits > 1) {
        multihits++;
      }

      // Handle a chunk of invoices
      if (ratesToCheck.length >= targetChunckSize) {
        const xledgerRows = await getSalesOrders(ratesToCheck)
        await updateDictionaryWithResponse(xledgerRows, ratesDictionary, statistics)
        ratesToCheck = []
        ratesDictionary = {}
      }
    }

    // We need to handle the leftover items to...
    const xledgerRows = await getSalesOrders(ratesToCheck)
    await updateDictionaryWithResponse(xledgerRows, ratesDictionary, statistics)


    // const updatedRows = await checkBatchesInXledger(ratesToCheck, ratesDictionary)
    return { rowsUpdated: updatedRows }
  }
  catch (error) {
    console.log(error)
  }
}

module.exports = {
  updatePaymentStatus,
}