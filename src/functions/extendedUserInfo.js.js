const { app } = require('@azure/functions');
const { getUser } = require('../lib/jobs/queryMSGraph.js');
const { logger } = require('@vtfk/logger');


app.http('extendedUserInfo', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'extendedUserInfo/{upn}',
    handler: async (request, context) => {
        const upn = request.params.upn
        try {
            const userInfo = await getUser(upn)
            return { status: 200, jsonBody: userInfo };
        } catch (error) {
            logger('error', ['extendedUserInfo', error])
            return { status: 400, jsonBody: error.message }
        }
       
    }
});
