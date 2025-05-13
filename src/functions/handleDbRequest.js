const { app } = require('@azure/functions');
const { postFormInfo, updateFormInfo, getDocuments, updateContractPCStatus } = require('../lib/jobs/queryMongoDB');
const config = require('../../config');
const { validateRoles } = require('../lib/auth/validateRoles');
const { logger } = require('@vtfk/logger');

app.http('handleDbRequest', {
    methods: ['GET', 'POST', 'PUT'],
    authLevel: 'anonymous',
    route: 'handleDbRequest',
    handler: async (request, context) => {
        const logPrefix = 'handleDbRequest'
        const authorizationHeader = request.headers.get('authorization')
        let isMock = request.query.get('isMock')
        isMock === 'true' ? isMock = true : isMock = false
        // Check the request method
        if (request.method === 'GET') {
            //Build a valid query object
            let query = {}
            if(request.query.get('school')) {
                // Push the school query to the query object
                query['elevInfo.skole'] = request.query.get('school')
            }   
                     
            // Check roles/school provided in the query string
            if(!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.read'])) {
                if(!request.query.get('school')) {
                    logger('warn', [`${logPrefix} - PUT`, 'Unauthorized access attempt'])
                    return { status: 403, body: 'Forbidden' }
                } 
            } 

            // Get documents from the database
            try {
                const result = await getDocuments(query, isMock)
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
                if(request.method === 'POST') {
                    if(!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.readwrite'])) {
                        logger('warn', [`${logPrefix} - POST`, 'Unauthorized access attempt'])
                        return { status: 403, body: 'Forbidden' }
                    } else {
                        // Update the database
                        try {
                            logger('info', [logPrefix, `Oppretter et dokument med UUID:${jsonBody.parseXml.result.ArchiveData.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`])
                            const result = await postFormInfo(jsonBody);
                            return { status: 200, jsonBody: result }
                        } catch (error) {
                            logger('error', [logPrefix, `Error ved oppretting av dokument med UUID:${jsonBody.parseXml.result.ArchiveData.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`, error])
                            return { status: 500, error }
                        }
                    }
                } else if(request.method === 'PUT') {
                    if(!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.itservicedesk-readwrite'])) {
                        logger('warn', [`${logPrefix} - PUT`, 'Unauthorized access attempt'])
                        return { status: 403, body: 'Forbidden' }
                    } else {
                        if(jsonBody.contractID && (jsonBody.releasePC === true || jsonBody.returnPC === true)) {
                            //Handle return or release of pc 
                            try {
                                logger('info', [logPrefix, `PC tilhørende kontrakt med _id: ${jsonBody.contractID} blir ${jsonBody.releasePC ? 'utlevert' : 'innlevert'}`])
                                const result = await updateContractPCStatus(jsonBody, isMock)
                                logger('info', [logPrefix, `PC tilhørende kontrakt med _id: ${jsonBody.contractID} er ${jsonBody.releasePC ? 'utlevert' : 'innlevert'}`])
                                return { status: 200, jsonBody: result }
                            } catch (error) {
                                logger('error', [logPrefix, `Error ved innlevering eller utlevering av PC, kontrakt _id: ${jsonBody.contractID}`, error])
                                return { status: 500, error }   
                            }
                        } else {
                            // Update the database
                            try {
                                logger('info', [logPrefix, `Oppdaterer dokument med UUID: ${jsonBody.parseXml.result.ArchiveData.uuid}`])
                                const result = await updateFormInfo(jsonBody);
                                return { status: 200, jsonBody: result }
                            } catch (error) {
                                logger('error', [logPrefix, `Error ved oppdatering av dokument med UUID: ${jsonBody.parseXml.result.ArchiveData.uuid}`, error])
                                return { status: 500, error }
                            }
                        }
                    }
                }
            }
        }
    }
});
