const { app } = require('@azure/functions');
const { logger } = require('@vtfk/logger');
const { postFormInfo, updateFormInfo } = require('../lib/jobs/queryMongoDB');

app.http('handleDbRequest', {
    methods: ['GET', 'POST', 'PUT'],
    authLevel: 'anonymous',
    route: 'handleDbRequest',
    handler: async (request, context) => {
        const logPrefix = 'handleDbRequest'
        // Check the request method
        if (request.method === 'GET') {
            // Handle GET request
            return { status: 200, body: 'GET request received' }
        } else if (request.method === 'POST' || request.method === 'PUT') {
            // Check if the request body is empty
            if (request.body === null) {
                return { status: 400, body: 'Bad Request, no body provided' }
            } else {
                const jsonBody = await request.json()
                if(request.method === 'POST') {
                    // Update the database
                    try {
                        logger('info', [logPrefix, `Oppretter et dokument med UUID:${jsonBody.parseXml.result.ArchiveData.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`])
                        const result = await postFormInfo(jsonBody);
                        return { status: 200, jsonBody: result }
                    } catch (error) {
                        logger('error', [logPrefix, `Error ved oppretting av dokument med UUID:${jsonBody.parseXml.result.ArchiveData.uuid}, refId: ${jsonBody.refId} og skjema navn: ${jsonBody.acosName}`, error])
                        return { status: 500, error }
                    }
                } else if(request.method === 'PUT') {
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
});
