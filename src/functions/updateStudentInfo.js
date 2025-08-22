const { app } = require('@azure/functions');
const { updateStudentInfo } = require('../lib/jobs/updateStudentInfo');

app.timer('updateStudentInfo', {
    // Runs every hour on the hour
    schedule: '0 0 * * * *',
    handler: async (myTimer, context) => {
        try {
            const report = await updateStudentInfo()
            return { status: 200, jsonBody: report }
        } catch (error) {
            return { status: 500, jsonBody: { error: 'Failed to update student UPN' } }
        }
    }
});
