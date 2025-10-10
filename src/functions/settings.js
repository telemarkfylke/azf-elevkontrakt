const { app } = require('@azure/functions');
const { logger } = require('@vtfk/logger');
const { updateDocument, getDocuments, postInitialSettings } = require('../lib/jobs/queryMongoDB');
const { validateRoles } = require('../lib/auth/validateRoles');

app.http('settings', {
    methods: ['GET','PUT'],
    authLevel: 'anonymous',
    route: 'settings',
    handler: async (request, context) => {
        const logPrefix = 'settings'
        const authorizationHeader = request.headers.get('authorization')
       
        // Validate the authorization header
        if(!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
            return { status: 403, body: 'Forbidden' }
        } 

        // Check the request method
        if (request.method === 'GET') {
            logger('info', [`${logPrefix} - ${request.method} request received`])
            // Handle GET request
            try {
                // Fetch and return settings from the database
                const settings = await getDocuments({}, 'settings')
                if (settings.status === 404 && settings.error === 'Fant ingen dokumenter') {
                    logger('error', [`${logPrefix} - ${request.method}`, 'No settings found in the database, create a settings document first.'])
                    const createBaseSettings = {
                        prices: {
                            reducedPrice: 0,
                            regularPrice: 0,
                        },
                        exceptionsFromRegularPrices: {
                            students: [],
                            classes: [],
                        }
                    }
                    const newSettings = await postInitialSettings(createBaseSettings)
                    if (newSettings.result.acknowledged !== true) {
                        logger('error', [`${logPrefix} - ${request.method}`, 'Error creating base settings document in the database'])
                        return { status: 500, body: 'Internal Server Error' }
                    } else {
                        logger('info', [`${logPrefix} - ${request.method}`, 'Base settings document created in the database'])
                        return { status: 202, jsonBody: newSettings }
                    }
                }
                return { status: 200, jsonBody: settings }
            } catch (error) {
                logger('error', [`${logPrefix} - ${request.method}`, 'Error handling GET request', error])
                return { status: 500, body: 'Internal Server Error' }
            }
        } else if (request.method === 'PUT') {
            logger('info', [`${logPrefix} - ${request.method} request received`])
            // Handle PUT request
            try {
                const body = await request.json()
                const settings = await getDocuments({}, 'settings')

                let id = ""
                if(!settings.status === 200) {
                    logger('error', [`${logPrefix} - ${request.method}`, 'No settings found in the database, create a settings document first.'])
                    return { status: 404, body: 'Not Found: No settings document found in the database' }
                } else if (settings.result[0]._id) {
                    // Use the existing settings document id
                    id = settings.result[0]._id
                }
                if (!body || Object.keys(body).length === 0) {
                    logger('error', [`${logPrefix} - ${request.method}`, 'No data provided in the request body'])
                    return { status: 400, body: 'Bad Request: No data provided' }
                }

                // Update settings in the database
                const updateSettings = await updateDocument(id, body, 'settings')
                if (updateSettings.acknowledged !== true) {
                    logger('error', [`${logPrefix} - ${request.method}`, 'Error updating settings in the database'])
                    return { status: 500, body: 'Internal Server Error' }
                } else {
                    logger('info', [`${logPrefix} - ${request.method}`, 'Settings updated successfully in the database'])
                    return { status: 200, jsonBody: updateSettings }
                }
            } catch (error) {
                logger('error', [`${logPrefix} - ${request.method}`, 'Error handling PUT request', error])
                return { status: 500, body: 'Internal Server Error' }
            }
        }
    }
});
