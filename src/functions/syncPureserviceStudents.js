const { app } = require('@azure/functions')
const { syncPureserviceStudents } = require('../lib/jobs/syncPureserviceStudents')

app.timer('syncPureserviceStudentsRegular', {
  // Every 15 minutes between August and December, and January to June
  // This will trigger a change stream sync for students in Pureservice, ensuring that any updates to student records are reflected in the system minimum 15 minutes after a contract is created.
  // The pureserviceId is needed to push info from the contract to the student record in Pureservice, so this function ensures that the pureserviceId is set on the student record in a timely manner.
  schedule: '0 */15 * * 8-12,1-6 *',
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
