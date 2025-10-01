const { app } = require('@azure/functions');
const { updateStudentInfo } = require('../lib/jobs/updateStudentInfo');

app.timer('updateStudentInfo', {
    // Once every day at 06:00 AM
    schedule: '0 6 * * *',
    handler: async (myTimer, context) => {
        try {
            const report = await updateStudentInfo()
            return { status: 200, jsonBody: report }
        } catch (error) {
            return { status: 500, jsonBody: { error: 'Failed to update student UPN' } }
        }
    }
});
