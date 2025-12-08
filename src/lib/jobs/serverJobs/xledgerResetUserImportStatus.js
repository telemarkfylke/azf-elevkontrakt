const { logger } = require('@vtfk/logger')
const { getDocuments, updateDocument } = require('../queryMongoDB.js')

/**
 * This job is responsible for resetting the import status for user in the contracts.
 * We need to update all the users in Xledger every year and set the field isImportedToXledger to false.
 * This job will find all documents that are marked as imported to Xledger and reset the field to false.
 * 
 * This job is typically run at the start of a new school year to ensure that all users are re-imported into Xledger.
 * 
 * The job will return a message indicating how many documents were updated.
 */

/**
 * Returns all documents that are marked as imported to Xledger and is a leieavtale.
 * 
 * @returns {Promise<Array>} - An array of documents that match the criteria.
*/
const getXledgerUserImportDocuments = async () => {
    const query = {
        'unSignedskjemaInfo.kontraktType': {$in: ['Leieavtale', 'leieavtale']}, // Only contracts of type 'Leieavtale' or 'leieavtale'
        'isImportedToXledger': {$eq: true}, // Only documents that are marked as imported to Xledger
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
 * Updates the import status for a specific document in Xledger.
 * @param {String} documentId - The ID of the document to update.
 * @returns {Promise<Object>} - The result of the update operation.
 */
const updateImportedDocument = async (documentId) => {
    const updateData = {  isImportedToXledger: false, importedToXledgerAt: "Ukjent" }
    try {
        const result = await updateDocument(documentId, updateData, 'regular')
        return result
    } catch (error) {
        logger('error', ['updateImportedDocument', 'Error updating document in database', error])
        throw error
    }
}

/**
 * Resets the import status for user documents in Xledger.
 * @returns {Promise<Object>} - An object containing a message about the operation.
 */

const resetUserImportStatus = async () => {
    const documents = await getXledgerUserImportDocuments()
    const loggerPrefix = 'resetUserImportStatus'
    if (documents.length === 0) {
        logger('info', [loggerPrefix, 'No documents found that are marked as imported to Xledger'])
        return { message: 'No documents found that are marked as imported to Xledger' }
    }
    let updatedCount = 0
    for (const doc of documents) {
        try {
            await updateImportedDocument(doc._id)
            updatedCount += 1
        } catch (error) {
            logger('error', [loggerPrefix, `Error updating document with _id ${doc._id}`, error])
        }
    }
    logger('info', [loggerPrefix, `Reset isImportedToXledger status for ${updatedCount} documents`])
    return { message: `Reset isImportedToXledger status for ${updatedCount} documents` }
}

module.exports = {
    resetUserImportStatus
}