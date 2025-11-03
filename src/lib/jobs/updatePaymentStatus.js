const { getDocuments, updateDocument } = require('../jobs/queryMongoDB.js');
const { getSalesOrders } = require('./queryXLedger.js');

// Primitiv enum substitutt
const RateStatus = {
  utlaan: 'Utlån faktureres ikke',
  betalt: 'Betalt',
  inkasso: 'Overført inkasso',
  ukjent: 'Ukjent',
  fakturert: 'Fakturert'
}

/**
 * 
 * @param {string} rateName 
 * @returns {Object}
 */
function addQueryRate(rateName) {
  const array = [{}, {}]
  array[0]["fakturaInfo." + rateName + ".løpenummer"] = { '$not': { '$in': [RateStatus.ukjent, null] } }
  array[1]["fakturaInfo." + rateName + ".status"] = { '$not': { '$in': [RateStatus.betalt, RateStatus.utlaan, RateStatus.inkasso] } }
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

  if (rate.løpenummer.substring(0, 4) === 'JOT-' && (rate.status === RateStatus.fakturert || rate.status === RateStatus.ukjent))
    return true

  return false
}

/**
 * 
 * @param {Array} xLedgerRows 
 * @param {Object} ratesDictionary 
 * @returns {number}
 */
async function compareAndUpdateStatus(xLedgerRows, ratesDictionary) {
  const updates = 0;

  xLedgerRows.forEach(async (row) => {
    const dictionaryEntry = ratesDictionary[row.extOrderNumber]

    // Fakturert, ikke betalt
    if (row.isPayed && (dictionaryEntry.rate.status !== RateStatus.betalt)) {
      //  Er det andre edgecases vi bør sjekke her ?   Kan det være statuser de har som ikke skal overskrives selv om den er betalt ?

      const updateData = {}
      updateData['fakturaInfo.' + dictionaryEntry.rateKey + '.status'] = RateStatus.betalt

      // Disabled så lenge vi er i prod verden
      // await updateDocument(dictionaryEntry.contract._id, updateData, 'regular')
      updates++
    }
  })
  return updates
}

/**
 * 
 * @param {Array} ratesToCheck 
 * @param {Object} ratesDictionary 
 * @returns 
 */
async function checkBatchesInXledger(ratesToCheck, ratesDictionary) {
  let index = 0
  const chunckSize = 100
  let updates = 0

  while (index < ratesToCheck.length) {
    const chunck = ratesToCheck.slice(index, chunckSize)
    const xledgerRows = await getSalesOrders(chunck, chunckSize)
    updates += (await compareAndUpdateStatus(xledgerRows, ratesDictionary))
    index += chunckSize
  }
  return updates
}

// For å se om denne raten er en kandidat for å sjekke opp imot xledger
const updatePaymentStatus = async () => {
  try {
    const documents = await fecthContractCandidatesFromMongoDB()

    const ratesToCheck = []
    const ratesDictionary = {}

    documents.result.forEach(contract => {
      let hits = 0;

      for (const [key, rate] of Object.entries(contract.fakturaInfo)) {
        if (checkRateCandidacy(rate)) {
          hits++
          ratesToCheck.push(rate.løpenummer)
          ratesDictionary[rate.løpenummer] = { rate: rate, contract: contract, rateKey: key }
        }
      }
      if (hits != 1) {
        /*
        Kommer vi hit er det antagelig noe feil med spørringen våre, eller datagrunnlaget.
        Da ligger det data der som faller mellom 2 stoler. Enten fordi flere av ratene er akutelle samtidig.
        Eller fordi vi henter noe fra databasen som koden ikke har tatt hensyn til.
        */
        console.log(JSON.stringify(contract))
      }
    });

    const updatedRows = await checkBatchesInXledger(ratesToCheck, ratesDictionary)
    return { rowsUpdated: updatedRows }
  }
  catch (error) {
    console.log(error)
  }
}



module.exports = {
  updatePaymentStatus,
}