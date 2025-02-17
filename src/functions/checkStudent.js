const { app } = require('@azure/functions');
const { validateStudentInfo } = require('../lib/validateStudent.js')

app.http('checkStudent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'checkStudent/{ssn}/{onlyAnsvarlig}',
    handler: async (request, context) => {
        const ssn = request.params.ssn
        const onlyAnsvarlig = request.params.onlyAnsvarlig
        const data = await validateStudentInfo(ssn, onlyAnsvarlig)

        return { jsonBody: data };
    }
});
