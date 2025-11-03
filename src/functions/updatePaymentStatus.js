const { app } = require('@azure/functions');
const { updatePaymentStatus } = require('../lib/jobs/updatePaymentStatus');

// LEgger det som rute nå for test. bør være timetrigger i prod
app.http('updatePaymentStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'dev/updatePaymentStatus',
    handler: async (request, context) => {
        const upn = request.params.upn
        try {
            const response = await updatePaymentStatus()
            return { status: 200, jsonBody: response };
        } catch (error) {
            logger('error', ['updatePaymentStatus', error])
            return { status: 400, jsonBody: error.message }
        }

    }
});


// Bør være timetrigger i prod
/*
app.timer('updatePaymentStatus', {
    // Once every day at 06:00 AM
    schedule: '0 6 * * *',
    handler: async (myTimer, context) => {
        try {
            const report = await updatePaymentStatus()
            return { status: 200, jsonBody: report }
        } catch (error) {
            return { status: 500, jsonBody: { error: 'Failed to update payment status' } }
        }
    }
});
*/