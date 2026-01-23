const { app } = require('@azure/functions')
const { postFormInfo, updateFormInfo, getDocuments, updateContractPCStatus, postManualContract, moveAndDeleteDocument, updateDocument } = require('../lib/jobs/queryMongoDB')
const { validateRoles } = require('../lib/auth/validateRoles')
const { archiveDocument } = require('../lib/jobs/queryArchive')
const { logger } = require('@vtfk/logger')
const { ObjectId } = require('mongodb')

app.http('handleDbRequest', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'handleDbRequest',
  handler: async (request, context) => {
    const logPrefix = 'handleDbRequest'
    const authorizationHeader = request.headers.get('authorization')
    let isMock = request.query.get('isMock')
    isMock === 'true' ? isMock = true : isMock = false
    // Check the request method
    if (request.method === 'GET') {
      const fetchDocumentsFromTargetCollection = request.headers.get('target-collection') ? request.headers.get('target-collection') : 'regular'
      // preImport | mock | regular | løpenummer | settings
      if (fetchDocumentsFromTargetCollection !== 'regular' && fetchDocumentsFromTargetCollection !== 'preImport' && fetchDocumentsFromTargetCollection !== 'mock' && fetchDocumentsFromTargetCollection !== 'løpenummer' && fetchDocumentsFromTargetCollection !== 'settings' && fetchDocumentsFromTargetCollection !== 'history' && fetchDocumentsFromTargetCollection !== 'pcIkkeInnlevert') {
        logger('error', [`${logPrefix}`, `Invalid target collection specified: ${fetchDocumentsFromTargetCollection}`])
        return { status: 400, body: 'Bad Request, invalid target collection specified' }
      }
      // Build a valid query object
      const query = {}
      if (request.query.get('school')) {
        // Push the school query to the query object
        query['elevInfo.skole'] = request.query.get('school')
      }

      if (request.query.get('contractID')) {
        // Push the contractID query to the query object
        // Valid format {_id: { $in:  [ '6926bf134830e2222ba37d76', '6926c0592b6fa4d8e9609eb3' ]}}
        const contractIDs = request.query.get('contractID').split(',')
        const contractsToQuery = []
        for (const id of contractIDs) {
          contractsToQuery.push(new ObjectId(id))
        }
        query._id = { $in: contractsToQuery }
      }

      if (request.query.get('navn')) {
        // Push the navn query to the query object
        query['elevInfo.navn'] = { $regex: request.query.get('navn'), $options: 'i' }
      }

      // Check roles provided in the query string
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.read', 'elevkontrakt.readwrite', 'elevkontrakt.skoleadministrator-write'])) {
        logger('error', [`${logPrefix} - GET`, 'Unauthorized access attempt', authorizationHeader])
        return { status: 403, body: 'Forbidden' }
      }

      // Get documents from the database
      try {
        const result = await getDocuments(query, isMock ? 'mock' : fetchDocumentsFromTargetCollection)
        return { status: 200, jsonBody: result }
      } catch (error) {
        logger('error', [logPrefix, 'Error fetching documents from database', error])
        return { status: 500, error }
      }
    } else if (request.method === 'POST' || request.method === 'PUT') {
      // Check if the request body is empty
      if (request.body === null) {
        return { status: 400, body: 'Bad Request, no body provided' }
      } else {
        const jsonBody = await request.json()
        if (request.method === 'POST') {
          if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.readwrite', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.skoleadministrator-write'])) {
            logger('error', [`${logPrefix} - POST`, 'Unauthorized access attempt', authorizationHeader])
            return { status: 403, body: 'Forbidden' }
          } else {
            // Check if the posted document is a manual contract.
            if (jsonBody.isManual) {
              logger('info', [logPrefix, 'Mottok et manuelt kontraktsdokument'])
              // Archive the manual contract
              logger('info', [logPrefix, 'Arkiverer manuelt kontraktsdokument'])
              let archive
              try {
                archive = await archiveDocument(jsonBody)
                /**
                                 * Example of the archive object that should be returned from the archiveDocument function
                                 * archive = {
                                 *     Recno: 201202,
                                 *     DocumentNumber: '23/00077-60',
                                 *     ImportedDocumentNumber: null,
                                 *     UID: '38cffcb5-77b7-4d9a-adf2-c669f57bb33e',
                                 *     UIDOrigin: '360'
                                 * }
                                 */
              } catch (error) {
                logger('error', [logPrefix, 'Error ved arkivering av manuelt kontraktsdokument', error])
                throw new Error('Internal server error', error)
              }
              // Create a new document with the provided data that can be used to update the database
              logger('info', [logPrefix, 'Oppretter et manuelt kontraktsdokument som kan postes til databasen'])
              let manualContract
              try {
                manualContract = await postManualContract(jsonBody, archive)
              } catch (error) {
                logger('error', [logPrefix, 'Error ved oppretting av manuelt kontraktsdokument', error])
                throw new Error('Internal server error', error)
              }
              return { status: 200, jsonBody: manualContract }
              // Update the database
            } else {
              // Handle non manual contracts posting to the database
              try {
                logger('info', [logPrefix, `Oppretter et dokument med UUID:${jsonBody.parseXml.result.ArchiveData.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`])
                const result = await postFormInfo(jsonBody)
                return { status: 200, jsonBody: result }
              } catch (error) {
                logger('error', [logPrefix, `Error ved oppretting av dokument med UUID:${jsonBody.parseXml?.result?.ArchiveData?.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`, error])
                throw new Error('Internal server error', error)
              }
            }
          }
        } else if (request.method === 'PUT') {
          const fetchDocumentsFromTargetCollection = request.headers.get('target-collection') ? request.headers.get('target-collection') : 'regular'
          // preImport | mock | regular | løpenummer | settings
          if (fetchDocumentsFromTargetCollection !== 'regular' && fetchDocumentsFromTargetCollection !== 'preImport' && fetchDocumentsFromTargetCollection !== 'mock' && fetchDocumentsFromTargetCollection !== 'løpenummer' && fetchDocumentsFromTargetCollection !== 'settings' && fetchDocumentsFromTargetCollection !== 'history' && fetchDocumentsFromTargetCollection !== 'pcIkkeInnlevert') {
            logger('error', [`${logPrefix}`, `Invalid target collection specified: ${fetchDocumentsFromTargetCollection}`])
            return { status: 400, body: 'Bad Request, invalid target collection specified' }
          }

          if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.skoleadministrator-write', 'elevkontrakt.readwrite'])) {
            logger('error', [`${logPrefix} - PUT`, 'Unauthorized access attempt', authorizationHeader])
            return { status: 403, body: 'Forbidden' }
          } else {
            if (jsonBody.contractID && (jsonBody.releasePC === 'true' || jsonBody.returnPC === 'true' || jsonBody.buyOutPC === 'true' || jsonBody.releasePC === 'false' || jsonBody.returnPC === 'false' || jsonBody.buyOutPC === 'false')) {
              // Handle return or release of pc
              let logMsg = ''
              if (jsonBody.releasePC === 'true' || jsonBody.returnPC === 'true' || jsonBody.buyOutPC === 'true') {
                logMsg = `PC tilhørende kontrakt med _id: ${jsonBody.contractID} blir ${jsonBody.releasePC === 'true' ? 'utlevert' : jsonBody.returnPC === 'true' ? 'innlevert' : 'kjøpt ut'}`
              } else if (jsonBody.releasePC === 'false' || jsonBody.returnPC === 'false' || jsonBody.buyOutPC === 'false') {
                logMsg = `PC tilhørende kontrakt med _id: ${jsonBody.contractID} er ${jsonBody.releasePC === 'false' ? 'satt tilbake til ikke utlevert' : jsonBody.returnPC === 'false' ? 'satt tilebake til ikke innlevert' : 'satt tilbake til ikke kjøpt ut'}`
              }
              try {
                logger('info', [logPrefix, logMsg])
                const result = await updateContractPCStatus(jsonBody, isMock, fetchDocumentsFromTargetCollection)
                logger('info', [logPrefix, `Oppdaterte PC status for kontrakt _id: ${jsonBody.contractID}`])
                return { status: 200, jsonBody: result }
              } catch (error) {
                logger('error', [logPrefix, `Error ved innlevering eller utlevering av PC, kontrakt _id: ${jsonBody.contractID}`, error])
                throw new Error('Internal server error', error)
              }
            } else if (jsonBody.contractID && jsonBody.updateData === true) {
              const logPrefix = `handleDbRequest - PUT - updateData - contractID: ${jsonBody.contractID}`

              // Handle updates to the document in the database from an external system.
              const changeLog = jsonBody.changeLog || []
              const dataToUpdate = jsonBody.data || {}

              // Merge changeLog and dataToUpdate into one object to be stored in the database
              const updateData = {
                data: dataToUpdate,
                changeLog
              }

              if (changeLog.length === 0) {
                logger('warn', [logPrefix, `Ingen endringer oppgitt i changeLog for dokument med kontraktID: ${jsonBody.contractID}. Ingen oppdatering utført.`])
                return { status: 400, body: 'Bad Request, no changes provided in changeLog' }
              }
              if (Object.keys(dataToUpdate).length === 0) {
                logger('warn', [logPrefix, `Ingen data oppgitt i data for dokument med kontraktID: ${jsonBody.contractID}. Ingen oppdatering utført.`])
                return { status: 400, body: 'Bad Request, no data provided in data' }
              }

              try {
                logger('info', [logPrefix, `Oppdaterer dokument med kontraktID: ${jsonBody.contractID}`])
                const result = await updateDocument(jsonBody.contractID, updateData, fetchDocumentsFromTargetCollection === 'pcIkkeInnlevert' ? 'pcIkkeInnlevert' : 'regularWithChangeLog')
                return { status: 200, jsonBody: result }
              } catch (error) {
                logger('error', [logPrefix, `Error ved oppdatering av dokument med kontraktID: ${jsonBody.contractID}`, error])
                return { status: 500, body: 'Internal server error' }
              }
            } else {
              // Update the database
              try {
                logger('info', [logPrefix, `Oppdaterer dokument med UUID: ${jsonBody.parseXml.result.ArchiveData.uuid}`])
                const result = await updateFormInfo(jsonBody)
                return { status: 200, jsonBody: result }
              } catch (error) {
                logger('error', [logPrefix, `Error ved oppdatering av dokument med UUID: ${jsonBody.parseXml.result.ArchiveData.uuid}`, error])
                throw new Error('Internal server error', error)
              }
            }
          }
        }
      }
    } else if (request.method === 'DELETE') {
      // Check roles/school provided in the query string
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
        if (!request.query.get('school')) {
          logger('error', [`${logPrefix} - DELETE`, 'Unauthorized access attempt', authorizationHeader])
          return { status: 403, body: 'Forbidden' }
        }
      }
      const jsonBody = await request.json()
      if (request.body === null) {
        return { status: 400, body: 'Bad Request, no body provided' }
      } else if (jsonBody.contractID && jsonBody.targetCollection) {
        /**
         * If Source is provided and mock === true, then source is mock
         */
        let sourceCollection = jsonBody.sourceCollection
        if(isMock === true) {
          sourceCollection = 'mock'
        }
        const result = await moveAndDeleteDocument(jsonBody.contractID, jsonBody.targetCollection, sourceCollection) // Source MIGHT be isMock
        if (result.status === 200) {
          logger('info', [`${logPrefix} - DELETE`, `Document with ID ${jsonBody.contractID} deleted successfully`])
          return { status: 200, body: `Document with ID ${jsonBody.contractID} deleted successfully` }
        } else if (result.status === 404) {
          logger('info', [`${logPrefix} - DELETE`, `Document with ID ${jsonBody.contractID} not found`])
          return { status: 404, body: `Document with ID ${jsonBody.contractID} not found` }
        } else {
          logger('error', [`${logPrefix} - DELETE`, `Failed to delete document with ID ${jsonBody.contractID}: ${result.body}`])
          return { status: 500, body: `Failed to delete document with ID ${jsonBody.contractID}: ${result.body}` }
        }
      } else {
        logger('error', [`${logPrefix} - DELETE`, 'Bad Request, contractID or targetCollection missing in body'])
        return { status: 400, body: 'Bad Request, contractID or targetCollection missing in body' }
      }
    }
  }
})
