const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')

app.http('updatePCStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    logger('info', ['updatePCStatus', 'Function started'])

    const requestBody = await request.json()
    logger('info', ['updatePCStatus', `Request body: ${JSON.stringify(requestBody)}`])

    const { studentId, newStatus } = requestBody



    if (!studentId || !newStatus) {
      logger('error', ['updatePCStatus', 'Missing studentId or newStatus in request body'])
      return { status: 400, body: 'Missing studentId or newStatus in request body' }
    }

    logger('info', ['updatePCStatus', `Updating PC status for studentId: ${studentId} to newStatus: ${newStatus}`])

    return { status: 200, body: 'PC status update function is running' }
  }
})
