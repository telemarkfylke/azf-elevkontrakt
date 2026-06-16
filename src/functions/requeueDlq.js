const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { processDlq } = require('../lib/changeStream/deadLetterQueue')

app.timer('requeueDlq', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    const logPrefix = 'requeueDlq'
    logger('info', [logPrefix, 'Timer trigger started'])
    try {
      const result = await processDlq()
      logger('info', [logPrefix, `Completed. Forwarded: ${result.forwarded}, failed/deferred: ${result.failed}`])
    } catch (err) {
      logger('error', [logPrefix, `Unhandled error: ${err.message}`])
      throw err
    }
  }
})

app.http('requeueDlqDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/requeueDlq',
  handler: async (request, context) => {
    const logPrefix = 'requeueDlqDev'
    logger('info', [logPrefix, 'HTTP trigger started'])
    try {
      const result = await processDlq()
      return { status: 200, jsonBody: result }
    } catch (err) {
      logger('error', [logPrefix, `Unhandled error: ${err.message}`])
      return { status: 500, jsonBody: { error: err.message } }
    }
  }
})
