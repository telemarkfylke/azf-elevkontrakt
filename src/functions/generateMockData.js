const { app } = require('@azure/functions');
const { postSignedForms, postUnSignedForms } = require('../lib/jobs/postTestDataToDB.js');
const config = require('../../config.js');
const { logger } = require('@vtfk/logger');
const { validateRoles } = require('../lib/auth/validateRoles.js');

app.http('generateMockData', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'generateMockData',
    handler: async (request, context) => {
        const authorizationHeader = request.headers.get('authorization')
        if(!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.read'])) {
            logger('warn', ['generateMockData', 'Unauthorized access attempt'])
            return { status: 403, body: 'Forbidden' }
        } else {
            let numberOfSignedForms = request.query.get('numberOfSignedForms');
            let numberOfUnSignedForms = request.query.get('numberOfUnSignedForms');

            // numberOfSignedForms og numberOfUnSignedForms kommer inn som string, må konverteres til number
            numberOfSignedForms = parseInt(numberOfSignedForms);
            numberOfUnSignedForms = parseInt(numberOfUnSignedForms);
            try {
                if(numberOfSignedForms) {
                    await postSignedForms(numberOfSignedForms);
                }
                if(numberOfUnSignedForms) {
                    await postUnSignedForms(numberOfUnSignedForms);
                }
            } catch (error) {
                return { status: 500, body: { error: error.message } };
            }
            return { jsonBody: {numberOfSignedForms: numberOfSignedForms, numberOfUnSignedForms: numberOfUnSignedForms} };
        }
    }
});
