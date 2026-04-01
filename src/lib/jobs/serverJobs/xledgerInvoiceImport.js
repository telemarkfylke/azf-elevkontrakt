const { getDocuments, updateDocument } = require('../queryMongoDB.js')
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

/**
 *
 * @param {Object} message | { updateCount, notFoundCount, updateCountOldFile, notFoundCountOldFile }
 * @param {string} type | The type of invoice import (buyOut, extraInvoice, normalInvoice)
 */
const sendTeamsMessage = async (message, type) => {
  const { updateCount, failedToUpdate } = message
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
      type: 'buyOut', 
      rates: { $elemMatch: { status: 'Ikke Fakturert', løpenummer: løpenummer } }
    }

    invoiceResult = await getDocuments(query, 'invoices')
  } else if (type === 'extraInvoice') {
    const query = { 
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

const generateInvoiceImportFile = async (importType, csvDataArray) => {
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
    logger('info', ['logPrefix', 'No data to create CSV file for invoice import'])
    return { message: 'No data to create CSV file for invoice import' }
  }
  // We might have to create the file in batches. Adjust rowsPerBatch to control the size of each batch.
  let batches = 1
  const rowsPerBatch = 0
  if (csvDataArray.length > rowsPerBatch && rowsPerBatch !== 0) {
    batches = Math.ceil(csvDataArray.length / rowsPerBatch)
  }
  const failedToUpdate = []
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
          await updateDocument(document.Dummy4, updateData, 'regular')
          logger('info', ['logPrefix - updateImportedDocument', `Updated document with _id: ${document.Dummy4}`])
        } else if (importType === 'buyOut') {
          const invoiceDocuments = await findInvoiceDocument(document, 'buyOut')
          if(invoiceDocuments.length === 0) {
            logger('error', ['updateImportedDocument', `No invoice document found for main contract with _id: ${document.Dummy4} and løpenummer: ${document['Order No']}. Skipping updating the invoice document.`])
            continue
          }
          // Find correct rate in the invoce document and update the document
          for (const invoiceDocument of invoiceDocuments) {
            // Update the main contract with updated status
            await updateDocument(invoiceDocument.customerContractId, updateData, invoiceDocument.mainDocumentCollectionSource)
            logger('info', ['logPrefix - updateImportedDocument', `Updated document with customerContractId: ${invoiceDocument.customerContractId} && _id: ${invoiceDocument._id}`])

            // Rate to update is the one that has the same løpenummer as the one in the imported document
            const rateToUpdate = invoiceDocument.rates.find(rate => rate.løpenummer === document['Order No'])
            if (!rateToUpdate) {
              logger('error', ['logPrefix - updateImportedDocument', `No rate found with løpenummer: ${document['Order No']} in invoice document with _id: ${invoiceDocument._id}. Skipping updating this invoice document.`])
              continue
            }

            // Replace the updateData keys to match the rate number in the invoice document
            const rateIndex = invoiceDocument.rates.indexOf(rateToUpdate) + 1
            const updatedRateData = {
              status: 'Fakturert',
              [`itemsFromCart.${rateIndex - 1}.status`]: 'Fakturert',
              [`itemsFromCart.${rateIndex - 1}.faktureringsDato`]: new Date().toISOString(),
              [`itemsFromCart.${rateIndex - 1}.løpenummer`]: document['Order No'],
              [`rates.${rateIndex - 1}.status`]: 'Fakturert',
              [`rates.${rateIndex - 1}.faktureringsDato`]: new Date().toISOString(),
            }
                       
            await updateDocument(invoiceDocument._id, updatedRateData, 'invoices')
            logger('info', ['logPrefix - updateImportedDocument', `Updated buyOut document with _id: ${invoiceDocument._id} as imported to Xledger`])
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
          
          logger('info', ['logPrefix - updateImportedDocument', `Updated document with _id: ${document.Dummy4}`])
        }
      } catch (error) {
        failedToUpdate.push(document.Dummy4)
        logger('error', ['logPrefix - updateImportedDocument', `Error updating document with _id: ${document.Dummy4}`, error])
      }
    }
  }
  // After processing all batches, send a message to teams with the results of the import and update process (One for each import type)
  if(importType === 'normalInvoice') {
    logger('info', [logPrefix, `Invoice import completed. ${csvDataArray.length} invoices imported and marked as 'Fakturert' in the database.`])
    await sendTeamsMessage({ updateCount: csvDataArray.length, failedToUpdate }, `normalInvoice`)
  } else if (importType === 'buyOut') {
    logger('info', [logPrefix, `BuyOut invoice import completed. ${csvDataArray.length} invoices imported and marked as 'Fakturert' in the database.`])
    await sendTeamsMessage({ updateCount: csvDataArray.length, failedToUpdate }, `buyOut`)
  } else if (importType === 'extraInvoice') {
    logger('info', [logPrefix, `Extra invoice import completed. ${csvDataArray.length} invoices imported and marked as 'Fakturert' in the database.`])
    await sendTeamsMessage({ updateCount: csvDataArray.length, failedToUpdate }, `extraInvoice`)
  }

  return { csvDataArray }
}

module.exports = {
  generateInvoiceImportFile
}
