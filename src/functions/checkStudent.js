const { app } = require('@azure/functions');
const { validateStudentInfo } = require('../lib/validateStudent.js');
const { validateRoles } = require('../lib/auth/validateRoles.js');
const config = require('../../config.js');
const { logger } = require('@vtfk/logger');

app.http('checkStudent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'checkStudent/{ssn}/{onlyAnsvarlig}/{version}',
    handler: async (request, context) => {
        const ssn = request.params.ssn
        const onlyAnsvarlig = request.params.onlyAnsvarlig
        const version = request.params.version
        // Validate the token 
        const authorizationHeader = request.headers.get('authorization')
        // TODO Rydde litt i rollene :)
        if(!validateRoles(authorizationHeader, ['elevkontrakt.read', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.administrator-readwrite'])) {
            logger('warn', ['checkStudent', 'Unauthorized access attempt'])
            return { status: 403, body: 'Forbidden' }
        } else {
            const data = await validateStudentInfo(ssn, onlyAnsvarlig, version)
            return { jsonBody: data };
        }
    }
});
