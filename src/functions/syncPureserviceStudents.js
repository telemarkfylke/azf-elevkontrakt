const { app } = require('@azure/functions')
const { syncPureserviceStudents } = require('../lib/jobs/syncPureserviceStudents')

app.timer('syncPureserviceStudentsRegular', {
  // Once every day at 07:00 AM
  schedule: '0 7 * * *',
  handler: async (myTimer, context) => {
    try {
      const report = await syncPureserviceStudents('regular')
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to sync Pureservice students' } }
    }
  }
})

app.timer('syncPureserviceStudentsPcIkkeLevert', {
  // Once every day at 07:15 AM
  schedule: '15 7 * * *',
  handler: async (myTimer, context) => {
    try {
      const report = await syncPureserviceStudents('pcIkkeInnlevert')
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to sync Pureservice students' } }
    }
  }
})

app.http('syncPureserviceStudentsDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/syncPureserviceStudents',
  handler: async (request, context) => {
    try {
      const report = await syncPureserviceStudents('pcIkkeInnlevert')
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to sync Pureservice students' } }
    }
  }
})
