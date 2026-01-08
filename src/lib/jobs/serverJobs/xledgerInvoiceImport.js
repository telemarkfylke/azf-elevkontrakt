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

/**
 * This job is responsible for importing invoices into Xledger.
 * The CSV file is created based on a template and includes information about the users and their invoices.
 * The job will also update the documents in the database to mark them as "Fakturert".
 *
 * The job will return a message indicating how many invoices were imported and how many documents were updated.
 * The job will also return two files: The CSV file that is going to be imported into Xledger and a CSV file for manual review (if any).
 */

const getThisYearsPriceList = async () => {
  const settings = await getDocuments({}, 'settings')
  return { prices: settings.result[0].prices, exceptionsFromRegularPrices: settings.result[0].exceptionsFromRegularPrices, exceptionsFromInvoiceFlow: settings.result[0].exceptionsFromInvoiceFlow } || {}
}

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
    'notFoundInFINT.date': { $exists: false }, // Not marked as not found in FINT
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
    const currentSchoolYear = getSchoolyear().split('-')[0] // E.g., "2024/2025" -> "2024"
    documents.result = documents.result.map(document => {
      const rates = document.fakturaInfo ? Object.values(document.fakturaInfo) : []
      let rateIndexToBeInvoiced = null
      for (let i = 0; i < rates.length; i++) {
        const rate = rates[i]
        if (rate.status === 'Ikke Fakturert' && rate.faktureringsår === currentSchoolYear) {
          rateIndexToBeInvoiced = i
          console.log('Found rate to be invoiced:', `fakturaInfo.rate${rateIndexToBeInvoiced + 1}, document ID: ${document._id}`)
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

const createCsvDataArray = async () => {
  const { documents } = await getXledgerInvoiceImports()

  if (!documents || documents.length === 0) {
    logger('info', ['createCsvDataArray', 'No documents found for invoice import'])
    return []
  }

  const { prices, exceptionsFromRegularPrices, exceptionsFromInvoiceFlow } = await getThisYearsPriceList()

  // Function to determine the correct price for a student
  const returnCorrectPriceForStudent = (fnr, studentClass, prices, exceptionsFromRegularPrices) => {
    // If there are no exceptions found in the settings, return the regular price
    if (exceptionsFromRegularPrices.students.length === 0 && exceptionsFromRegularPrices.classes.length === 0) {
      return prices.regularPrice
    }

    if (exceptionsFromRegularPrices.students.length > 0) {
      // Check if the student is in the exceptions list
      const studentException = exceptionsFromRegularPrices.students.find(student => student.fnr === fnr)
      if (studentException) {
        return prices.reducedPrice
      }
    }

    if (exceptionsFromRegularPrices.classes.length > 0) {
      // Check if the student is in the class exceptions list
      const classException = exceptionsFromRegularPrices.classes.find(cls => cls.className === studentClass)
      if (classException) {
        return prices.reducedPrice
      }
    }

    // If no exceptions found on the student, return regular price
    return prices.regularPrice
  }

  // Function to check if a student has an exception in the invoice flow
  const hasInvoiceFlowException = (fnr, exceptionsFromInvoiceFlow) => {
    const exception = exceptionsFromInvoiceFlow.students.find(entry => entry.fnr === fnr)
    return !!exception
  }
  // documents.splice(10) // Limit to first 10 documents for testing

  const csvDataArray = []
  for (const { rateToBeInvoiced, document } of documents) {

    const hasException = hasInvoiceFlowException(document.elevInfo.fnr, exceptionsFromInvoiceFlow)
    if (hasException) {
      // Using Error for easy notification to teams, so we know why we are skipping this document, and as a reminder to remove the exception later/manually handle the invoice
      logger('error', ['createCsvDataArray', `Document with _id: ${document._id} has an exception in the invoice flow. Skipping invoice import.`])
      continue // Skip this document
    }

    const schoolInfo = schoolInfoList.find(school => school.orgNr.toString() === document?.skoleOrgNr)
    const csvData = {
      'Owner ID/Entity Code': '39006',
      ImpSystem: 'Skoleutvikling - JOTNE',
      'Order No': await generateSerialNumber(rateToBeInvoiced.rateNumber), // Serial number for the invoice
      'Line No': '1',
      // 'Date': new Date().toLocaleDateString('no-NO'), // Xledger will set the date automatically to the date of import
      'Ready To Invoice': '1', // Sett tu manual review in Xledger before sending the invoice
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
 * @param {string} type | 'utlevering' | 'innlevering'
 */
const sendTeamsMessage = async (message) => {
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
              text: 'Statusrapport - azf-elevkontrakt - Fakturaimport til Xledger',
              wrap: true,
              style: 'heading'
            },
            {
              type: 'TextBlock',
              text: `**${updateCount}** dokument(er) er merket som 'Fakturert' i databasen etter vellykket fakturaimport til Xledger.`,
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

const generateInvoiceImportFile = async () => {
  const logPrefix = 'generateInvoiceImportFile'
  logger('info', [logPrefix, 'Starting invoice import file generation job'])
  // Create CSV data array
  const csvDataArray = await createCsvDataArray()
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
    const fileNameForImport = `SO01b_2_Invoice_Base_subledger_import_File_Number_${i + 1}_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}.csv`
    const filePath = `./src/data/xledger_files/faktura_files/${fileNameForImport}`
    fs.writeFileSync(filePath, csvString, 'utf8')
    logger('info', [logPrefix, `CSV file created at ${filePath}`])

    // Import the file to Xledger
    try {
      const importResult = await fileImport('SO01b_2', filePath, fileNameForImport)

      if(importResult.errors) {
        logger('error', [logPrefix, 'Xledger import returned errors', importResult.errors])
        return new Error('Xledger import returned errors')
      }

      if(importResult.data.addImportFiles.edges.length === 0) {
        logger('error', [logPrefix, 'Xledger import returned no edges, something went wrong', importResult])
        return new Error('Xledger import returned no edges')
      }

      logger('info', [logPrefix, `File imported to Xledger with result: ${JSON.stringify(importResult)}`])
    } catch (error) {
      logger('error', [logPrefix, 'Error importing file to Xledger', error])
      return new Error('Error importing file to Xledger')
    }

    // After importing, move the file to the finished folder
    const finishedFilePath = `./src/data/xledger_files/faktura_files/finished/${fileNameForImport}`
    fs.renameSync(filePath, finishedFilePath)
    logger('info', [logPrefix, `CSV file moved to finished folder at ${finishedFilePath}`])

    // Write back to the database that the documents have been invoiced

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
        await updateDocument(document.Dummy4, updateData, 'regular')
        logger('info', ['logPrefix - updateImportedDocument', `Updated document with _id: ${document.Dummy4} as imported to Xledger`])
      } catch (error) {
        failedToUpdate.push(document.Dummy4)
        logger('error', ['logPrefix - updateImportedDocument', `Error updating document with _id: ${document.Dummy4} as imported to Xledger`, error])
      }
    }
  }

  await sendTeamsMessage({ updateCount: csvDataArray.length, failedToUpdate }, 'invoiceImport')

  return { csvDataArray }
}

module.exports = {
  generateInvoiceImportFile
}
