const { app } = require('@azure/functions')
const { updateStudentUPN } = require('../lib/jobs/updateStudentUPN')

app.timer('updateStudentUPNFromUkjent', {
  schedule: '0 */15 * * * *', // Every 5 minutes
  handler: async (myTimer, context) => {
    try {
      const documents = await updateStudentUPN()
      return { status: 200, jsonBody: documents }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to update student UPN' } }
    }
  }
})
