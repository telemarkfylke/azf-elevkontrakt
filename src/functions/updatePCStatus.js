const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')

app.http('updatePCStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    logger('info', ['updatePCStatus', 'Function started'])

    const requestBody = await request.json()
    logger('info', ['updatePCStatus', `Request body: ${JSON.stringify(requestBody)}`])

    return { status: 200, body: 'PC status update function is running' }
  }
})
