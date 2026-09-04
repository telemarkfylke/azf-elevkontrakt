const { getDocuments, updateDocument } = require('../queryMongoDB.js')
const { findContractById, assertContractUpdated } = require('../findContract.js')
const { logger } = require('@vtfk/logger')
const fs = require('fs')
const path = require('path')
const { generateSerialNumber } = require('../../helpers/getSerialNumber.js')
const { getSchoolyear } = require('../../helpers/getSchoolyear.js')
const { schoolInfoList } = require('../../datasources/tfk-schools.js')
const axios = require('axios')
const { teams } = require('../../../../config.js')
const { fileImport } = require('../queryXledger.js')
const { returnCorrectPriceForStudent } = require('../../helpers/getCorrectRatePrice.js')
const { hasInvoiceFlowException } = require('../../helpers/checkInvoiceFlowException.js')
const { getThisYearsPriceList } = require('../../helpers/getSettings.js')
const { ObjectId } = require('mongodb')

/**
 * This job is responsible for importing invoices into Xledger.
 * The CSV file is created based on a template and includes information about the users and their invoices.
 * The job will also update the documents in the database to mark them as "Fakturert".
 *
 * The job will return a message indicating how many invoices were imported and how many documents were updated.
 * The job will also return two files: The CSV file that is going to be imported into Xledger and a CSV file for manual review (if any).
 */

/**
 * Fetches the user and generates the payload needed for the invoice import.
 * @returns {Promise<Array>} - An array of documents that match the criteria.
*/
const getXledgerInvoiceImports = async () => {
  /**
     * Fetches the user import documents from the database.
     *
     * For test:
     * 68948f665166f5c34fb43154 - notFoundInFINT.date does exist
     * 68eca0803d0c9adcaa16b8c6 - notFoundInFINT does not exist, but is not imported to Xledger
     * 68c6e64b944198a0dd2986a8 - notFoundInFINT dose not exist, but is imported to Xledger more than 7 days ago
     * 6894c7b1a16460009a36564f - notFindInFINT does exist but is an empty object, is imported to Xledger more than last 7 days
     *
     * Result should be that document 68948f665166f5c34fb43154 and 68eca0803d0c9adcaa16b8c6 is excluded from the result.
     *
     * For production, remove the _id query
     *
     * Query explanation:
     * We are looking for documents that match the following criteria:
     * - The contract type is either 'Leieavtale' or 'leieavtale'.
     * - The document is marked as imported to Xledger (isImportedToXledger is true || "true").
     * - The document was imported to Xledger more than 7 days ago (importedToXledgerAt is less than or equal to the current date minus 7 days).
     * - The document is not marked as not found in FINT (notFoundInFINT.date does not exist).
     *
     * This ensures that we only get documents that are relevant for the invoice import process.
     *
     */

  const currentSchoolYear = getSchoolyear().split('-')[0] // E.g., "2024/2025" -> "2024"
  const query = {
    // '_id': { $in: [new ObjectId('68344862d29bf2ace91ac102'), new ObjectId('683c4575e898fc6f3b65b128'), new ObjectId('6840accce898fc6f3b65b12c'), new ObjectId('6840accde898fc6f3b65b12d')] }, // Only specific documents for testing
    'unSignedskjemaInfo.kontraktType': { $in: ['Leieavtale', 'leieavtale'] }, // Only contracts of type 'Leieavtale' or 'leieavtale'
    isImportedToXledger: { $eq: true }, // Already imported to Xledger (this school year, a job will reset this field for all documents at the start of a new school year)
    importedToXledgerAt: { $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Check that the document import is 7 days older or more
    // 'notFoundInFINT.date': { $exists: false }, // Not marked as not found in FINT (we will handle this in the rate check below, some times FINT said that students are not found, even if they are still students at the school)
    $or: [
      { 'fakturaInfo.rate1.faktureringsår': { $in: [currentSchoolYear, parseInt(currentSchoolYear)] } }, // Find documents where at least one of the rates is the current school year, look for both string and number (incase :P)
      { 'fakturaInfo.rate2.faktureringsår': { $in: [currentSchoolYear, parseInt(currentSchoolYear)] } },
      { 'fakturaInfo.rate3.faktureringsår': { $in: [currentSchoolYear, parseInt(currentSchoolYear)] } }
    ]
  }
  try {
    const documents = await getDocuments(query, 'regular')
    const noRateToInvoice = []
    // For each document find the correct rate to be invoiced. The rate to be invoiced is the first rate that has status "Ikke Fakturert" and is in the current school year.
    const currentSchoolYear = getSchoolyear().split('-')[0].toString() // E.g., "2024/2025" -> "2024"
    documents.result = documents.result.map(document => {
      const rates = document.fakturaInfo ? Object.values(document.fakturaInfo) : []
      let rateIndexToBeInvoiced = null
      for (let i = 0; i < rates.length; i++) {
        const rate = rates[i]
        if (rate.status === 'Ikke Fakturert' && rate.faktureringsår.toString() === currentSchoolYear) {
          // Check if the student has lless than 5 days leeway from the notFoundInFINT date, to avoid invoicing students that are not found in FINT over a peroid of 5 consecutive days.
          if (document?.notFoundInFINT && Object.keys(document.notFoundInFINT).length > 0) {
            const notFoundDates = Object.values(document.notFoundInFINT).map(entry => new Date(entry.date))
            const hasLeeway = notFoundDates.every(date => {
              const daysDiff = Math.floor((Date.now() - date) / (1000 * 60 * 60 * 24))
              return daysDiff > 5
            })
            if (!hasLeeway) {
              logger('info', ['getXledgerInvoiceImports', `Student ID: ${document._id} has notFoundInFINT entry older than 5 days, skipping invoicing.`])
              continue
            }
          }
          rateIndexToBeInvoiced = i
          logger('info', ['getXledgerInvoiceImports', `Rate to be invoiced found for document ID: ${document._id}`])
          break
        }
      }
      if (rateIndexToBeInvoiced === null) {
        logger('info', ['getXledgerInvoiceImports', `No rate to be invoiced found for document ID: ${document._id}`])
        noRateToInvoice.push({ documentId: document._id, fakturaInfo: document.fakturaInfo, elevInfo: document.elevInfo })
      } else {
        return { rateToBeInvoiced: { path: `fakturaInfo.rate${rateIndexToBeInvoiced + 1}`, rateNumber: rateIndexToBeInvoiced + 1 }, document }
      }
    })
    // Remove documents that has no rate to be invoiced
    documents.result = documents.result.filter(item => item !== undefined)
    return { documents: documents.result } || []
  } catch (error) {
    logger('error', ['getXledgerInvoiceImports', 'Error fetching documents from database', error])
    throw error
  }
}
/**
 * Returns an array of CSV data objects based on the documents to be invoiced.
 * Each object in the array represents a row in the CSV file to be imported into Xledger.
 * Only for normal invoices, buyOut and extra invoices will have different formats and are implemented in separate functions.
 * @returns {Promise<Array>} - An array of CSV data objects.
 */
const createCsvDataArray = async () => {
  const { documents } = await getXledgerInvoiceImports()

  if (!documents || documents.length === 0) {
    logger('info', ['createCsvDataArray', 'No documents found for invoice import'])
    return []
  }

  const { prices, exceptionsFromRegularPrices, exceptionsFromInvoiceFlow } = await getThisYearsPriceList()
  // documents.splice(10) // Limit to first 10 documents for testing

  const csvDataArray = []
  for (const { rateToBeInvoiced, document } of documents) {

    const hasException = hasInvoiceFlowException(document.elevInfo.fnr, exceptionsFromInvoiceFlow)
    if (hasException) {
      // Using Error for easy notification to teams, so we know why we are skipping this document, and as a reminder to remove the exception later/manually handle the invoice
      logger('error', ['createCsvDataArray', `Document with _id: ${document._id} has an exception in the invoice flow. Skipping invoice import.`])
      continue // Skip this document
    }

    const schoolInfo = schoolInfoList.find(school => school.orgNr === document?.skoleOrgNr)
    const csvData = {
      'Owner ID/Entity Code': '39006',
      ImpSystem: 'Skoleutvikling - JOTNE',
      'Order No': await generateSerialNumber(rateToBeInvoiced.rateNumber), // Serial number for the invoice
      'Line No': '1',
      // 'Date': new Date().toLocaleDateString('no-NO'), // Xledger will set the date automatically to the date of import
      'Ready To Invoice': '1', // Sett to manual review in Xledger before sending the invoice (1 means manual review, 0 means ready to be invoiced without review)
      Product: '4651000', // Product code for "ElevPC",
      'Tekst (imp)': `Faktura for ${document.elevInfo.navn} - Leie av elev-PC`, // Description text for the invoice line
      Quantity: '1',
      'Unit Price': returnCorrectPriceForStudent(document.elevInfo.fnr, document.elevInfo.klasse, prices, exceptionsFromRegularPrices), // Price based on settings and exceptions
      'Company No': document.ansvarligInfo.fnr || document.signedBy.fnr, // Person that will be invoiced
      'Service Type': '465',
      'Your Ref': document.elevInfo.navn, // Name of the student
      'SO Group': '465',
      'Header Info': schoolInfo?.xledgerInvoiceHeaderInfo || 'Spørsmål vedrørende faktura, ta kontakt med skolen din', // Unique header text for each school
      Dummy4: document._id, // Will not be imported to Xledger, used to update the document in the database after import
      'End Of Line': 'X'
    }
    // Build the CSV row based on the document and the rate to be invoiced
    csvDataArray.push(csvData)
  }
  return csvDataArray
}

const createCsvString = async (csvData) => {
  const csvRows = []
  const headerRow = []

  // Get the header row from the SO01b_2 Invoice_Base_Transactions_with_subledger_(XL Extended)_template.csv file
  const filePath = './src/lib/csvImportTemplates/SO01b_2 Invoice_Base_Transactions_with_subledger_(XL Extended)_template.csv'
  const fileContent = fs.readFileSync(path.resolve(filePath), 'utf8')
  const lines = fileContent.split('\n')
  if (lines.length > 0) {
    headerRow.push(lines[0].trim())
  }

  // Add data rows
  for (const row of csvData) {
    const csvRow = []
    for (const header of headerRow[0].split(';')) {
      const trimmedHeader = header.trim()
      csvRow.push(row[trimmedHeader] !== undefined ? row[trimmedHeader] : '')
    }
    // Add the header row if it's the first row
    if (csvRows.length === 0) {
      csvRows.push(headerRow[0])
    }
    // Join the CSV row and push it to the rows array
    csvRows.push(csvRow.join(';'))
  }

  // Join rows into a single newline-delimited string so fs.writeFileSync receives a string
  return csvRows.join('\n')
}

// A Teams adaptive card is capped at ~28KB, and an end-of-year batch can hold back a lot of
// invoices at once - so the card prints the first few and refers to the log for the rest.
const MAX_SKIPPED_FACTS_IN_CARD = 20

// After this many days a hold has stopped looking like "the import job has not caught up yet" and
// starts looking like a hold that will never lift on its own. xledgerUserImport only sets
// isImportedToXledger for contracts in 'kontrakter' whose kontraktType is a Leieavtale/Låneavtale,
// and only for the recipients that made it into the automatic import file - a recipient created by
// hand in Xledger (the manual-review list), a contract with kontraktType 'Ukjent', or one already
// archived to pc-ikke-innlevert never gets the flag, so its invoice would otherwise be held quietly
// forever. Escalating on the card makes that visible instead of it repeating unnoticed.
const HELD_ESCALATION_DAYS = 14

/**
 * Builds the "left alone" section of the status card: the count, one FactSet per invoice, and an
 * escalation line for holds old enough to need a human.
 *
 * Pure and exported so the escalation logic can be tested without stubbing axios.
 *
 * Age comes from the invoice's createdTimeStamp: an invoice with status 'Ikke Fakturert' is picked up
 * by every run, so how long it has been pending IS how long it has been held. Invoices predating that
 * field report an unknown age and never escalate, rather than guessing.
 *
 * @param {Array<Object>} skipped | Skip records from resolveRecipientImportStatus
 * @param {Object} [options]
 * @param {Number} [options.now] | Epoch ms, injectable for tests
 * @returns {Array<Object>} | Adaptive card body blocks (empty array for an empty list)
 */
const buildHeldBackSection = (skipped, options = {}) => {
  const { now = Date.now() } = options

  const daysPending = (skip) => {
    const created = skip.createdTimeStamp ? new Date(skip.createdTimeStamp).getTime() : NaN
    if (!Number.isFinite(created)) return null
    return Math.max(0, Math.floor((now - created) / (1000 * 60 * 60 * 24)))
  }

  const withAge = skipped.map(skip => ({ skip, days: daysPending(skip) }))
  // Oldest first, unknown age last: the list is capped, so the holds that need attention have to be
  // the ones that survive the cap.
  const ordered = [...withAge].sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
  const escalated = ordered.filter(({ days }) => days !== null && days >= HELD_ESCALATION_DAYS)

  return [
    {
      type: 'TextBlock',
      text: `**${skipped.length}** faktura(er) ble **ikke** sendt til Xledger fordi mottakeren ikke er importert dit (isImportedToXledger er ikke true). De står urørt med status 'Ikke Fakturert' og forsøkes på nytt når flagget settes.`,
      wrap: true,
      weight: 'Bolder',
      size: 'Medium'
    },
    ...(escalated.length > 0
      ? [{
          type: 'TextBlock',
          text: `**Krever oppfølging:** ${escalated.length} av disse har ventet i mer enn ${HELD_ESCALATION_DAYS} dager. Flagget settes ikke automatisk for alle - mottakere som er opprettet manuelt i Xledger, kontrakter med kontraktType 'Ukjent' og kontrakter som ligger i pc-ikke-innlevert får det aldri. Sjekk om mottakeren finnes i Xledger og sett isImportedToXledger manuelt.`,
          wrap: true,
          weight: 'Bolder',
          color: 'Attention'
        }]
      : []),
    ...ordered.slice(0, MAX_SKIPPED_FACTS_IN_CARD).map(({ skip, days }) => ({
      type: 'FactSet',
      facts: [
        { title: 'Elev:', value: skip.studentName },
        { title: 'Mottaker:', value: `${skip.recipientName} (${skip.recipientFnr})` },
        { title: 'Ventet:', value: days === null ? 'ukjent (fakturaen mangler createdTimeStamp)' : `${days} dag(er)` },
        { title: 'Kontrakt ID:', value: skip.customerContractId },
        { title: 'Faktura ID:', value: skip.invoiceId },
        { title: 'Collection:', value: skip.documentType || 'ikke funnet' },
        { title: 'Årsak:', value: skip.reason }
      ]
    })),
    ...(ordered.length > MAX_SKIPPED_FACTS_IN_CARD
      ? [{
          type: 'TextBlock',
          text: `... og ${ordered.length - MAX_SKIPPED_FACTS_IN_CARD} flere, se loggen.`,
          wrap: true
        }]
      : [])
  ]
}

/**
 *
 * @param {Object} message | { updateCount, failedToUpdate, skippedNotImportedToXledger }
 *   skippedNotImportedToXledger: invoices left alone because the recipient is not imported to Xledger.
 *   Pass an array (even an empty one) to get the count printed on the card; omit it entirely to leave
 *   the section out - normalInvoice has no such section, since its query already filters on the flag.
 * @param {string} type | The type of invoice import (buyOut, extraInvoice, normalInvoice)
 */
const sendTeamsMessage = async (message, type) => {
  const { updateCount, failedToUpdate = [], skippedNotImportedToXledger } = message
  const hasSkippedSection = Array.isArray(skippedNotImportedToXledger)
  const skipped = hasSkippedSection ? skippedNotImportedToXledger : []
  const teamsMsg = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          msteams: { width: 'full' },
          body: [
            {
              type: 'TextBlock',
              text: `Statusrapport - azf-elevkontrakt - ${type} fakturaimport til Xledger`,
              wrap: true,
              style: 'heading'
            },
            {
              type: 'TextBlock',
              text: `**${updateCount}** dokument(er) er merket som 'Fakturert' i databasen etter vellykket ${type} fakturaimport til Xledger.`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `**${failedToUpdate.length}** dokument(er) kunne ikke oppdateres.`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: failedToUpdate.length > 0 ? failedToUpdate.map(docId => ({ title: 'Dokument ID:', value: docId })) : [{ title: 'Status:', value: 'Alle dokumenter ble oppdatert uten feil.' }]
            },
            // Held-back invoices: nothing failed here, they were deliberately not sent. Kept on this
            // card (rather than its own) because they belong to the same run's tally - the count is
            // printed even when it is 0, so it is visible that the check ran.
            ...(hasSkippedSection ? buildHeldBackSection(skipped) : []),
            {
              type: 'Image',
              url: 'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExazY1ajBqcW50dTlzYTZ2Yzdpb3Uxd3FrNGxvamJ3MW80MmZ6NDY0cCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/uiuP6Fdb8bdYElPLZU/giphy.gif',
              horizontalAlignment: 'Center'
            }
          ]
        }
      }
    ]
  }
  const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
  const postStatus = await axios.post(teams.webhook, teamsMsg, { headers })
  return postStatus
}

/**
 * Sends a Teams alert when the Xledger import for a batch fails before any documents could be marked as 'Fakturert'.
 * Without this, a failed import (e.g. Xledger returning errors) silently aborts status write-back for the whole batch,
 * and the same documents get picked up and resent on the next scheduled run with nobody aware of the failure.
 * @param {String} type | The type of invoice import (buyOut, extraInvoice, normalInvoice)
 * @param {Error} error | The error that caused the import to fail
 */
const sendImportFailureAlert = async (type, error) => {
  const teamsMsg = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          msteams: { width: 'full' },
          body: [
            {
              type: 'TextBlock',
              text: `Feilmelding - azf-elevkontrakt - ${type} fakturaimport til Xledger`,
              wrap: true,
              style: 'heading'
            },
            {
              type: 'TextBlock',
              text: `Import av **${type}**-fakturaer til Xledger feilet. Ingen dokumenter ble oppdatert i databasen for denne batchen - de vil bli forsøkt fakturert på nytt neste gang jobben kjører.`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `Feilmelding: ${error?.message || error}`,
              wrap: true
            }
          ]
        }
      }
    ]
  }
  const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
  return await axios.post(teams.webhook, teamsMsg, { headers })
}

/**
 * Alerts on invoices that reached Xledger successfully but whose parent contract could not be
 * updated - a stranded contract, not a failed invoice.
 *
 * Deliberately its own card rather than an extra FactSet on sendTeamsMessage: that card's heading
 * reads "kunne ikke oppdateres" and prints only a document id, which would misdescribe these. The
 * student HAS been invoiced; what is missing is the rate status on the contract, and fixing it needs
 * the contract id, the rate and the exact update that was refused - all of which are printed here.
 * @param {String} importType | The type of invoice import (buyOut, extraInvoice, normalInvoice)
 * @param {Array<Object>} failedContractUpdates
 */
const sendContractWriteBackAlert = async (importType, failedContractUpdates) => {
  const teamsMsg = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          msteams: { width: 'full' },
          body: [
            {
              type: 'TextBlock',
              text: `Krever oppfølging - azf-elevkontrakt - ${importType} fakturaimport til Xledger`,
              wrap: true,
              style: 'heading'
            },
            {
              type: 'TextBlock',
              text: `**${failedContractUpdates.length}** faktura(er) ble fakturert i Xledger, men raten kunne **ikke** oppdateres på kontrakten. Fakturaen er altså sendt - det er kontrakten som mangler statusen, og den må rettes manuelt.`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            ...failedContractUpdates.map(failure => ({
              type: 'FactSet',
              facts: [
                { title: 'Faktura ID:', value: String(failure.invoiceId) },
                { title: 'Kontrakt ID:', value: String(failure.customerContractId) },
                { title: 'Collection:', value: failure.documentType || 'ikke funnet' },
                { title: 'Rate:', value: `rate${failure.rateNumber} (${failure.løpenummer})` },
                { title: 'Årsak:', value: failure.reason },
                { title: 'Avvist oppdatering:', value: JSON.stringify(failure.refusedUpdate ?? {}) }
              ]
            }))
          ]
        }
      }
    ]
  }
  const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
  return await axios.post(teams.webhook, teamsMsg, { headers })
}

/**
 *
 * @param {String} customerContractId | The ID of the customer contract to find the invoice document for
 * @param {String} type | [buyOut, extraInvoice]
 * @returns | The invoice document(s) that match the criteria, or an empty array if no document is found
 */
const findInvoiceDocument = async (document, type) => {

  let customerContractId = document.Dummy4
  let løpenummer = document['Order No']

  let invoiceResult
  // Check invoice type [buyOut, extraInvoice] and return the correct one based on the type
  if(type === 'buyOut') {
    const query = {
      _id: new ObjectId(customerContractId), // customerContractId = document.Dummy4 = invoice _id
      type: 'buyOut'
    }

    invoiceResult = await getDocuments(query, 'invoices')
  } else if (type === 'extraInvoice') {
    // Dummy4 is the invoice _id here too (xledgerExtraInvoice.js sets it from invoice._id for both
    // types). Without the _id filter this returned every pending extraInvoice in the system, so the
    // length === 0 guard below could never trip for the invoice actually being processed.
    const query = {
      _id: new ObjectId(customerContractId),
      type: 'extraInvoice',
      status: 'Ikke Fakturert',
    }

    invoiceResult = await getDocuments(query, 'invoices')
  }

  if(invoiceResult.status !== 200 || invoiceResult.result.length === 0) {
    logger('error', [`findInvoiceDocument - ${type}`, `No invoice document found for customerContractId: ${customerContractId} and løpenummer: ${løpenummer}`])
    return []
  } else {
    return invoiceResult.result
  }
}

/**
 * Writes one imported buyOut rate back to both the invoice document and its parent contract.
 *
 * Split out of generateInvoiceImportFile so it can be tested: by the time this runs the CSV is
 * already in Xledger, so the ordering guarantees below are the only thing standing between a failed
 * contract write and a double-invoiced student.
 *
 * Two rules hold in every branch:
 *
 * 1. The invoice document is ALWAYS updated, even when the contract write fails. The
 *    xledgerExtraInvoice job selects candidates on `status: 'Ikke Fakturert'`, so an invoice left
 *    unflipped is re-sent to Xledger on the next run - the student is invoiced twice. A contract
 *    that is merely behind can be repaired; a duplicate invoice cannot be un-sent.
 * 2. The collection is resolved from the database, never from the invoice's
 *    mainDocumentCollectionSource. That field records where the contract lived when the invoice was
 *    created, and the contract has very likely moved since - a student who leaves with an
 *    outstanding invoice is archived to historiske-avtaler-pc-ikke-innlevert by design. Writing to
 *    the stale collection matched nothing, silently, and stranded the contract there for good.
 *
 * @param {Object} invoiceDocument - the buyOut invoice document
 * @param {String} orderNo - the CSV row's 'Order No' (the rate's løpenummer)
 * @param {Number} rateNumber - rate number parsed out of orderNo
 * @param {Object} updateData - the fakturaInfo.rateN update built by the caller
 * @param {Object} [deps]
 * @returns {Promise<{contractUpdated: boolean, invoiceUpdated: boolean, failure: Object|null}>}
 */
const updateImportedBuyOutDocument = async (invoiceDocument, orderNo, rateNumber, updateData, deps = {}) => {
  const {
    findContractByIdFn = findContractById,
    updateDocumentFn = updateDocument,
    logger: _logger = logger
  } = deps

  const logPrefix = 'updateImportedBuyOutDocument'

  // Find the rate FIRST before updating anything — avoids partial updates if the rate is missing
  const rateToUpdate = invoiceDocument.rates.find(rate => rate.løpenummer === orderNo)
  if (!rateToUpdate) {
    _logger('error', [logPrefix, `No rate found with løpenummer: ${orderNo} in invoice document with _id: ${invoiceDocument._id}. Skipping updating this invoice document.`])
    return {
      contractUpdated: false,
      invoiceUpdated: false,
      failure: {
        invoiceId: String(invoiceDocument._id),
        customerContractId: String(invoiceDocument.customerContractId),
        løpenummer: orderNo,
        rateNumber,
        documentType: null,
        reason: `Fant ingen rate med løpenummer ${orderNo} i fakturadokumentet`
      }
    }
  }
  const rateIndex = invoiceDocument.rates.indexOf(rateToUpdate) + 1

  // Update the main contract — use 'Fakturert - Utkjøp' to preserve the buyOut-specific status
  const buyOutContractUpdateData = {
    ...updateData,
    [`fakturaInfo.rate${rateNumber}.status`]: 'Fakturert - Utkjøp'
  }

  let failure = null
  let contractUpdated = false
  try {
    const { documentType } = await findContractByIdFn(invoiceDocument.customerContractId)

    if (documentType === null) {
      _logger('error', [logPrefix, `No contract found in any collection for customerContractId: ${invoiceDocument.customerContractId} (invoice _id: ${invoiceDocument._id}). The invoice is invoiced in Xledger but the contract cannot be updated.`])
      failure = { documentType: null, reason: 'Fant ingen kontrakt i kontrakter, pc-ikke-innlevert eller historiske-avtaler' }
    } else if (documentType === 'history') {
      // historiske-avtaler is the final archive and is not written to. Reaching this means a
      // contract with a live invoice got in there anyway - the DELETE route is now gated, so this
      // is an invariant violation, not a routine outcome. Reported for a manual move back out.
      _logger('error', [logPrefix, `Contract ${invoiceDocument.customerContractId} is in historiske-avtaler, which is not writable. Rate ${rateNumber} was NOT updated (invoice _id: ${invoiceDocument._id}). Move the contract back to kontrakter or pc-ikke-innlevert and re-apply manually.`])
      failure = { documentType, reason: 'Kontrakten ligger i historiske-avtaler (endelig arkiv) og kan ikke oppdateres. Flytt den ut av arkivet og påfør raten manuelt.' }
    } else {
      const updateResult = await updateDocumentFn(invoiceDocument.customerContractId, buyOutContractUpdateData, documentType)
      const { updated, reason } = assertContractUpdated(updateResult, `${logPrefix} - kontrakt ${invoiceDocument.customerContractId} i '${documentType}'`)
      if (updated) {
        contractUpdated = true
        _logger('info', [logPrefix, `Updated contract with customerContractId: ${invoiceDocument.customerContractId} in '${documentType}' && invoice _id: ${invoiceDocument._id}`])
      } else {
        failure = { documentType, reason }
      }
    }
  } catch (error) {
    // Contained on purpose: the invoice write below must happen regardless (rule 1 above).
    _logger('error', [logPrefix, `Error updating contract ${invoiceDocument.customerContractId} for invoice _id: ${invoiceDocument._id}`, error])
    failure = { documentType: null, reason: `Feil ved oppdatering av kontrakt: ${error.message}` }
  }

  if (failure) {
    failure = {
      invoiceId: String(invoiceDocument._id),
      customerContractId: String(invoiceDocument.customerContractId),
      løpenummer: orderNo,
      rateNumber,
      refusedUpdate: buyOutContractUpdateData,
      ...failure
    }
  }

  // Always runs - see rule 1.
  const updatedRateData = {
    status: 'Fakturert',
    [`itemsFromCart.${rateIndex - 1}.status`]: 'Fakturert',
    [`itemsFromCart.${rateIndex - 1}.faktureringsDato`]: new Date().toISOString(),
    [`itemsFromCart.${rateIndex - 1}.løpenummer`]: orderNo,
    [`rates.${rateIndex - 1}.status`]: 'Fakturert',
    [`rates.${rateIndex - 1}.faktureringsDato`]: new Date().toISOString(),
  }
  await updateDocumentFn(invoiceDocument._id, updatedRateData, 'invoices')
  _logger('info', [logPrefix, `Updated buyOut document with _id: ${invoiceDocument._id} as imported to Xledger`])

  return { contractUpdated, invoiceUpdated: true, failure }
}

/**
 * @param {String} importType | buyOut, extraInvoice or normalInvoice
 * @param {Array} csvDataArray | The CSV rows to import (built by the caller; normalInvoice builds its own)
 * @param {Object} [options]
 * @param {Array<Object>} [options.skippedNotImportedToXledger] | Invoices the caller left alone because
 *   the recipient is not imported to Xledger. Reported on the Teams card; only buyOut/extraInvoice pass it.
 */
const generateInvoiceImportFile = async (importType, csvDataArray, options = {}) => {
  const { skippedNotImportedToXledger = [] } = options
  // Spread into the Teams payload so only callers that actually pass the option (buyOut/extraInvoice)
  // get the held-back section on their card - normalInvoice gates on the flag in its query instead.
  const skippedSection = Array.isArray(options.skippedNotImportedToXledger) ? { skippedNotImportedToXledger } : {}
  const logPrefix = 'generateInvoiceImportFile'
  logger('info', [logPrefix, 'Starting invoice import file generation job'])

  if (importType === 'buyOut') {
    logger('info', [logPrefix, 'Import type: buyOut'])
  } else if (importType === 'extraInvoice') {
    logger('info', [logPrefix, 'Import type: extraInvoice'])
  } else if (importType === 'normalInvoice') {
    logger('info', [logPrefix, 'Import type: normalInvoice'])
  } else {
    logger('error', [logPrefix, 'Invalid import type provided. Must be either "buyOut", "extraInvoice", or "normalInvoice".'])
    throw new Error('Invalid import type provided. Must be either "buyOut", "extraInvoice", or "normalInvoice".')
  }
  if(importType === 'normalInvoice') {
    // Create CSV data array for normal invoices
    csvDataArray = await createCsvDataArray()
  } else if (importType === 'buyOut') {
    csvDataArray = csvDataArray 
  } else if (importType === 'extraInvoice') {
    csvDataArray = csvDataArray
  }
  if (csvDataArray.length === 0) {
    logger('info', [logPrefix, 'No data to create CSV file for invoice import'])
    // "Nothing to import" is exactly what a batch where every invoice was held back looks like, and
    // that is the case the report matters most in - so the card is still sent when there are skips.
    if (skippedNotImportedToXledger.length > 0) {
      logger('info', [logPrefix, `No CSV rows to import: all ${skippedNotImportedToXledger.length} ${importType} invoice(s) were left alone because the recipient is not imported to Xledger.`])
      // Contained: this path used to have no side effects at all, so a throw here (a webhook 429, say)
      // would surface in processInvoices' catch and fire sendImportFailureAlert - reporting an Xledger
      // import failure for a batch that never reached Xledger. Nothing was sent and nothing was
      // written;
      try {
        await sendTeamsMessage({ updateCount: 0, failedToUpdate: [], ...skippedSection }, importType)
      } catch (error) {
        logger('error', [logPrefix, `Could not post the Teams report for ${skippedNotImportedToXledger.length} held-back ${importType} invoice(s). They are unchanged and will be retried.`, error])
      }
    }
    // Same shape as the normal return path: callers read result.csvDataArray.length, and a bare
    // { message } made that a TypeError (runExtraInvoiceImport.js).
    return { csvDataArray: [], updatedCount: 0, failedToUpdate: [], failedContractUpdates: [], skippedNotImportedToXledger, message: 'No data to create CSV file for invoice import' }
  }
  // We might have to create the file in batches. Adjust rowsPerBatch to control the size of each batch.
  let batches = 1
  const rowsPerBatch = 0
  if (csvDataArray.length > rowsPerBatch && rowsPerBatch !== 0) {
    batches = Math.ceil(csvDataArray.length / rowsPerBatch)
  }
  const failedToUpdate = []
  // Contract write-backs that failed while the invoice itself reached Xledger fine. Kept apart from
  // failedToUpdate because they mean something different, and reported on their own Teams card.
  const failedContractUpdates = []
  // Rows actually written back, so the Teams report can stop claiming every CSV row succeeded.
  let updatedCount = 0
  for (let i = 0; i < batches; i++) {
    let batchData
    if (rowsPerBatch !== 0) {
      batchData = csvDataArray.slice(i * rowsPerBatch, (i + 1) * rowsPerBatch)
    } else {
      batchData = csvDataArray
    }

    // Create CSV string from data array
    const csvString = await createCsvString(batchData)
    const fileNameForImport = `SO01b_2_Invoice_Base_subledger_import_File_Number_${i + 1}_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}_${importType}.csv`
    const filePath = `./src/data/xledger_files/faktura_files/${fileNameForImport}`
    fs.writeFileSync(filePath, csvString, 'utf8')
    logger('info', [logPrefix, `CSV file created at ${filePath}`])

    // Import the file to Xledger
    try {
      const importResult = await fileImport('SO01b_2', filePath, fileNameForImport)
      
      if(importResult.data.errors) {
        logger('error', [logPrefix, 'Xledger import returned errors', importResult.data.errors])
        throw new Error('Xledger import returned errors')
      }

      if(importResult.data.data.addImportFiles?.edges.length === 0) {
        logger('error', [logPrefix, 'Xledger import returned no edges, something went wrong', importResult])
        throw new Error('Xledger import returned no edges')
      }

      logger('info', [logPrefix, `File imported to Xledger successfully: ${fileNameForImport}`])
    } catch (error) {
      logger('error', [logPrefix, 'Error importing file to Xledger', error])
      throw new Error('Error importing file to Xledger')
    }

    // After importing, move the file to the finished folder
    const finishedFilePath = `./src/data/xledger_files/faktura_files/finished/${fileNameForImport}`
    fs.renameSync(filePath, finishedFilePath)
    logger('info', [logPrefix, `CSV file moved to finished folder at ${finishedFilePath}`])

    // Write back to the database that the documents have been invoiced
    let lastExtraInvoiceOrderNo = null
    for (const document of batchData) {
      try {

        // Get rate from the 'Order No' field
        const rateNumber = parseInt(document['Order No'].split('-')[2], 10) // JOT-000000001-2-2025-ptc9lm
        const updateData = {
          [`fakturaInfo.rate${rateNumber}.status`]: 'Fakturert',
          [`fakturaInfo.rate${rateNumber}.faktureringsDato`]: new Date().toISOString(),
          [`fakturaInfo.rate${rateNumber}.løpenummer`]: document['Order No'],
          [`fakturaInfo.rate${rateNumber}.sum`]: document['Unit Price']
        }

        if(importType === 'normalInvoice') {
          const normalResult = await updateDocument(document.Dummy4, updateData, 'regular')
          const { updated, reason } = assertContractUpdated(normalResult, `updateImportedDocument - kontrakt ${document.Dummy4} i 'regular'`)
          if (!updated) {
            failedToUpdate.push(document.Dummy4)
            logger('error', ['logPrefix - updateImportedDocument', `Failed to update document with _id: ${document.Dummy4}: ${reason}`])
            continue
          }
          updatedCount++
          logger('info', ['logPrefix - updateImportedDocument', `Updated document with _id: ${document.Dummy4}`])
        } else if (importType === 'buyOut') {
          // findInvoiceDocument queries by _id, so this is at most one document. The multiplicity
          // is the other way round: handleBuyOutInvoice emits one CSV row per rate, all sharing
          // Dummy4 = invoice._id, so the same invoice is processed once per rate.
          const invoiceDocuments = await findInvoiceDocument(document, 'buyOut')
          if(invoiceDocuments.length === 0) {
            logger('error', ['updateImportedDocument', `No invoice document found for invoice with _id: ${document.Dummy4} and løpenummer: ${document['Order No']}. Skipping updating the invoice document.`])
            continue
          }
          for (const invoiceDocument of invoiceDocuments) {
            const { contractUpdated, invoiceUpdated, failure } = await updateImportedBuyOutDocument(
              invoiceDocument, document['Order No'], rateNumber, updateData
            )
            if (failure) {
              failedContractUpdates.push(failure)
            }
            if (invoiceUpdated && contractUpdated) {
              updatedCount++
            }
          }

        } else if (importType === 'extraInvoice') {
          // To avoid handling the same document multiple times (For products, where one invoice has the same "Order No" for multiple lines), we will check if the document has already been updated before trying to update it again. If the document has already been updated, we will skip it.
          // We'll check this by checking if the last "Order No" processed is the same as the current "Order No", if it is the same, we will skip the update for this document.
          if (lastExtraInvoiceOrderNo === document['Order No']) {
            logger('info', ['logPrefix - updateImportedDocument', `Document with _id: ${document.Dummy4} has the same "Order No" as the last processed document. Skipping updating this document to avoid handling the same document multiple times.`])
            continue
          }
          logger('info', ['logPrefix - updateImportedDocument', `Updating extraInvoice document with customerContractId: ${document.Dummy4}`])

          const invoiceDocuments = await findInvoiceDocument(document, 'extraInvoice')
          if(invoiceDocuments.length === 0) {
            logger('error', ['updateImportedDocument', `No invoice document found for main contract with _id: ${document.Dummy4} and løpenummer: ${document['Order No']}. Skipping updating the invoice document.`])
            continue
          }

          const updateExtraInvpoiceData = {
            status: 'Fakturert',
            faktureringsDato: new Date().toISOString(),
            løpenummer: document['Order No'],
          }

          await updateDocument(document.Dummy4, updateExtraInvpoiceData, 'invoices')

          // Save the last "Order No" processed.
          lastExtraInvoiceOrderNo = document['Order No']

          updatedCount++
          logger('info', ['logPrefix - updateImportedDocument', `Updated document with _id: ${document.Dummy4}`])
        }
      } catch (error) {
        failedToUpdate.push(document.Dummy4)
        logger('error', ['logPrefix - updateImportedDocument', `Error updating document with _id: ${document.Dummy4}`, error])
      }
    }
  }
  // After processing all batches, send a message to teams with the results of the import and update
  // process (One for each import type). updateCount is what was actually written back, not
  // csvDataArray.length - reporting the row count made a batch where every write-back failed look
  // like a clean run.
  if(importType === 'normalInvoice') {
    logger('info', [logPrefix, `Invoice import completed. ${updatedCount} of ${csvDataArray.length} invoices marked as 'Fakturert' in the database.`])
    await sendTeamsMessage({ updateCount: updatedCount, failedToUpdate, ...skippedSection }, `normalInvoice`)
  } else if (importType === 'buyOut') {
    logger('info', [logPrefix, `BuyOut invoice import completed. ${updatedCount} of ${csvDataArray.length} invoices marked as 'Fakturert' in the database. ${skippedNotImportedToXledger.length} invoice(s) left alone (recipient not imported to Xledger).`])
    await sendTeamsMessage({ updateCount: updatedCount, failedToUpdate, ...skippedSection }, `buyOut`)
  } else if (importType === 'extraInvoice') {
    logger('info', [logPrefix, `Extra invoice import completed. ${updatedCount} of ${csvDataArray.length} invoices marked as 'Fakturert' in the database. ${skippedNotImportedToXledger.length} invoice(s) left alone (recipient not imported to Xledger).`])
    await sendTeamsMessage({ updateCount: updatedCount, failedToUpdate, ...skippedSection }, `extraInvoice`)
  }

  // Separate card: these invoices ARE in Xledger, only their contract mirror is behind. Folding
  // them into the card above would file them under "kunne ikke oppdateres", which misdescribes them.
  if (failedContractUpdates.length > 0) {
    await sendContractWriteBackAlert(importType, failedContractUpdates)
  }

  return { csvDataArray, updatedCount, failedToUpdate, failedContractUpdates, skippedNotImportedToXledger }
}

module.exports = {
  generateInvoiceImportFile,
  sendImportFailureAlert,
  sendContractWriteBackAlert,
  updateImportedBuyOutDocument,
  buildHeldBackSection,
  HELD_ESCALATION_DAYS
}
