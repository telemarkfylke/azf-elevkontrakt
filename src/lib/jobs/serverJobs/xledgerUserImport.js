
const { person } = require('../queryFREG.js')
const { lookupKRR } = require('../queryKRR.js')
const { getDocuments, updateDocument } = require('../queryMongoDB.js')
const { logger } = require('@vtfk/logger')
const fs = require('fs')
const path = require('path')

/**
 * This job is responsible for creating a CSV file for importing users into Xledger.
 * The CSV file is created based on a template and includes information about the users
 * such as name, address, phone number, email, and contract details.
 * The job will also update the documents in the database to mark them as imported to Xledger.
 * 
 * The job will return the CSV string and an array of documents that failed to fetch person data.
 * 
 * The job will typically be run at the start of a new school year to ensure that all users are imported into Xledger.
*/

/**
 * Fetches the user import documents from the database.
 * @returns {Promise<Array>} - An array of documents that match the criteria.
*/
const getXledgerUserImportDocuments = async () => {
    const query = {
        'unSignedskjemaInfo.kontraktType': {$in: ['Leieavtale', 'leieavtale']}, // Only contracts of type 'Leieavtale' or 'leieavtale'
        'isImportedToXledger': {$ne: true}, // Not yet imported to Xledger (this school year, a job will reset this field for all documents at the start of a new school year)
    }
    try {
        const documents = await getDocuments(query, 'regular') 
        return documents.result || []
    } catch (error) {
        logger('error', ['getXledgerUserImportDocuments', 'Error fetching documents from database', error])
        throw error
    }
}
/**
 * Update a document in the database to mark it as imported to Xledger.
 * @param {String} documentId - The ID of the document to update.
 * @returns {Promise<Object>} - The result of the update operation.
 */
const updateImportedDocument = async (documentId) => {
    if(!documentId) {
        throw new Error('No documentId provided')
    }
    const updateData = {  isImportedToXledger: true, importedToXledgerAt: new Date() }
    try {
        const result = await updateDocument(documentId, updateData, 'regular')
        return result
    } catch (error) {
        logger('error', ['updateImportedDocument', 'Error updating document in database', error])
        throw error
    }
}

/**
 * Fetch person data from FREG for a given document.
 * 
 * @param {Object} document - The document containing the person number.
 * @returns {Promise<Object>} - The person data from FREG.
 */
const getPersonData = async (document) => {
    if (!document.ansvarligInfo || !document.ansvarligInfo.fnr) {
        logger('warn', ['getPersonData', 'Document does not contain elevInfo or fnr'])
        return null
    }
    try {
        const personData = await person(document.ansvarligInfo.fnr)
        return personData
    } catch (error) {
        logger('error', ['getPersonData', 'Error fetching person data from FREG', error])
        throw error
    }
}

/**
 * Fetch the KRR data for a given person. 
 * 
 * @param {String} ssn - The person data containing the fnr.
 * @returns {Promise<Object>} - The KRR data for the person or empty object.
 */
const getKRRData = async (ssn) => {
    if (!ssn) {
        logger('warn', ['getKRRData', 'No ssn provided'])
        return {}
    }
    try {
        const krrData = await lookupKRR(ssn)
        return krrData.personer[0] || {}
    } catch (error) {
        logger('error', ['getKRRData', 'Error fetching KRR data', error])
        throw error
    }
}

/**
 * Convert a string to proper case (title case).
 * 
 * @param {String} str - The string to convert.
 * @returns {String} - The string in proper case.
 */
const toProperCase = (str) => {
    if (!str) return str
    // Convert to lower case and then to title case, taking into account norwegian characters æøå
    return str.toLowerCase().replace(/(^|\s|[-.])\S/g, (match) => match.toUpperCase())
}

const addExtraZero = (num) => {
    return num < 10 ? `0${num}` : num
}

/**
 * Fetch person data for all documents and create the csvstring using template literals. 
 * 
 * @returns {Promise<string>} - A string containing the CSV data.
 */

const createCsvString = async (csvData) => {
    const csvRows = []
    const headerRow = []
    
    // Get the header row from the SL04-SYS_Subledger_Import_template.csv file
    const filePath = `./src/lib/csvImportTemplates/SL04-SYS_Subledger_Import_template.csv`
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
 * Create a new array with only the necessary fields for the CSV export.
 * @returns {Promise<Array>} - A new array containing only the necessary fields.
 */
 const createCsvDataArray = async () => {
    const logPrefix = 'createCsvDataArray'
    const documents = await getXledgerUserImportDocuments()
    if (!documents || documents.length === 0) {
        logger('info', [logPrefix, 'No documents found for Xledger user import'])
        return ''
    }

    // Take only the 10 first for test
    // documents.splice(10)

    const csvDataArray = []
    const csvDataArrayForManualReview = []
    const documentsThatFailed = []
    for (const document of documents) {
        const personData = await getPersonData(document)
        const krrData = await getKRRData(document.ansvarligInfo.fnr)
        if (!personData || !krrData) {
            logger('warn', [logPrefix, `No person data or krr data found for document with _id: ${document._id}`])
            documentsThatFailed.push(document._id)
            continue
        } else if (toProperCase(personData.bostedsadresse?.postnummer) === "9999" || toProperCase(personData.postadresse?.postnummer) === "9999") {
            logger('info', [logPrefix, `Person data for document with _id: ${document._id} contains 'Ukjent Adresse', creating CSV document for manual review`])
                const csvData = {
                'City': toProperCase(personData.bostedsadresse?.poststed || personData.postadresse?.poststed) || null,
                'Update Level': 2,
                'Ledger Type Imp': 'AR',
                // 'Your Ref': `V${new Date().getFullYear()}`, // Removed, this field is shown on every invoice created in Xledger, we dont want that.
                'Notes': `${new Date().getFullYear()}-${addExtraZero(new Date().getMonth() + 1)}`, // Notes can include additional information about the user, in our case it will be the year the student or the parent is imported.
                'UUID': document._id,
                // 'Contract': `${toProperCase(document.unSignedskjemaInfo.kontraktType)}-${new Date().getFullYear()}` || null, // Removed, this field is shown on every invoice created in Xledger, we dont want that.
                'CompanyNo': (personData.foedselsEllerDNummer || document.ansvarligInfo.fnr) || null,
                'Description': toProperCase(personData.fulltnavn) || null,
                'Street Address': toProperCase(personData.bostedsadresse?.gateadresse || personData.postadresse?.gateadresse) || null,
                'Zip Code': toProperCase(personData.bostedsadresse?.postnummer || personData.postadresse?.postnummer) || null,
                'City': toProperCase(personData.bostedsadresse?.poststed || personData.postadresse?.poststed) || null,
                'Phone': krrData.kontaktinformasjon?.mobiltelefonnummer || null,
                'E-mail': krrData.kontaktinformasjon?.epostadresse || null,
                'End Of Line': 'x' // End of line
            }
            csvDataArrayForManualReview.push(csvData)
        } else {
            logger('info', [logPrefix, `Fetched person data for document with _id: ${document._id}`])
            const csvData = {
                'City': toProperCase(personData.bostedsadresse?.poststed || personData.postadresse?.poststed) || null,
                'Update Level': 2,
                'Ledger Type Imp': 'AR',
                // 'Your Ref': `V${new Date().getFullYear()}`,
                'Notes': `${new Date().getFullYear()}-${addExtraZero(new Date().getMonth() + 1)}`, // Notes can include additional information about the user, in our case it will be the year the student or the parent is imported.
                'UUID': document._id,
                // 'Contract': `${toProperCase(document.unSignedskjemaInfo.kontraktType)}-${new Date().getFullYear()}` || null,
                'CompanyNo': (personData.foedselsEllerDNummer || document.ansvarligInfo.fnr) || null,
                'Description': toProperCase(personData.fulltnavn) || null,
                'Street Address': toProperCase(personData.bostedsadresse?.gateadresse || personData.postadresse?.gateadresse) || null,
                'Zip Code': toProperCase(personData.bostedsadresse?.postnummer || personData.postadresse?.postnummer) || null,
                'City': toProperCase(personData.bostedsadresse?.poststed || personData.postadresse?.poststed) || null,
                'Phone': krrData.kontaktinformasjon?.mobiltelefonnummer || null,
                'E-mail': krrData.kontaktinformasjon?.epostadresse || null,
                'End Of Line': 'x' // End of line
            }
            csvDataArray.push(csvData)
        }
    }
    // Create a csv file from the csvDataArray
    const csvString = await createCsvString(csvDataArray)
    const filePath = `./src/data/xledger_files/user_import_files/SL04-SYS_xledger_user_import_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}.csv`
    fs.writeFileSync(filePath, csvString, 'utf8')
    logger('info', [logPrefix, `CSV file created at ${filePath}`])

    // Create a csv file from the csvDataArrayForManualReview if there are any documents that need manual review
    if (csvDataArrayForManualReview.length > 0) {
        const csvStringForManualReview = await createCsvString(csvDataArrayForManualReview)
        const filePathForManualReview = `./src/data/xledger_files/user_import_files/SL04-SYS_xledger_user_import_MANUAL_REVIEW_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}.csv`
        fs.writeFileSync(filePathForManualReview, csvStringForManualReview, 'utf8')
        logger('info', [logPrefix, `CSV file for manual review created at ${filePathForManualReview}`])
    }
   
    // Write back to the database that the documents have been imported to Xledger
    for (const document of csvDataArray) {
        try {
            await updateImportedDocument(document.UUID)
            logger('info', [logPrefix, `Updated document with _id: ${document.UUID} as imported to Xledger`])
        } catch (error) {
            logger('error', [logPrefix, `Error updating document with _id: ${document.UUID} as imported to Xledger`, error])
        }
    }
    
    // return csvString
    return {csvDataArray, csvDataArrayForManualReview, documentsThatFailed}
}

module.exports = {
    createCsvDataArray
}