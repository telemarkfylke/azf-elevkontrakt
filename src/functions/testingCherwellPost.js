const { app } = require('@azure/functions');
const { logger } = require('@vtfk/logger');

app.http('testingCherwellPost', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        logger('info', ['testingCherwellPost', 'Function started']);

        const requestBody = await request.json();
        logger('info', ['testingCherwellPost', `Request body: ${JSON.stringify(requestBody)}`]);

        return { status: 200, body: 'Cherwell post test function is running' };

        
    }
});
