const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { updatePCStatus } = require('../lib/jobs/updatePCStatus')

app.http('updatePCStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const logPrefix = 'updatePCStatus'
    logger('info', [logPrefix, 'Function started'])

    const { studentId, newStatus, requestMadeBy } = await request.json()

    if (!studentId || !newStatus || !requestMadeBy) {
      logger('error', [logPrefix, 'Missing studentId, newStatus or requestMadeBy in request body'])
      return { status: 400, body: 'Missing studentId, newStatus or requestMadeBy in request body' }
    }

    try {
      const result = await updatePCStatus(studentId, newStatus, requestMadeBy)
      return { status: 200, jsonBody: result }
    } catch (error) {
      logger('error', [logPrefix, error.message])
      const status = error.status ?? 500
      return { status, body: error.message }
    }
  }
})
