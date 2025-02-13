const { app } = require('@azure/functions');
const { validateStudentInfo } = require('../lib/validateStudent.js')

app.http('checkStudent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'checkStudent/{ssn}',
    handler: async (request, context) => {
        const ssn = request.params.ssn
        const data = await validateStudentInfo(ssn)

        return { jsonBody: data };
    }
});
