const { app } = require('@azure/functions')
const { updateStudentInfo } = require('../lib/jobs/updateStudentInfo')

app.timer('updateStudentInfo', {
  // Once every day at 06:00 AM
  schedule: '0 6 * * *',
  handler: async (myTimer, context) => {
    try {
      const report = await updateStudentInfo(false, false)
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to update student information', details: error.message } }
    }
  }
})

/**
 * This timer function is set to run every hour from 07:00 to 16:00 on weekdays. It calls the updateStudentInfo function with skipCache and updateOnlyIfPCStatusIsFalse set to true.
 * This is useful for ensuring that student information is kept up-to-date during working hours, especially for documents where the PC status is false.
 * The function returns a report object containing counts of updated documents, moved documents, and students not found in FINT.
 * 
 * This function is only needed durring the start of semester when students are being added to the system and their information is being updated frequently. After the initial period, this function can be disabled to reduce load on the system.
 * Studnets may swap schools frequently during the start of semester, and this function ensures that their information is updated in a timely manner.
 */
app.timer('updateStudentInfoSkipCache', {
  // Every hour from 07:00 to 16:00 on weekdays
  schedule: '0 0 7-16 * * 1-5',
  handler: async (myTimer, context) => {
    try {
      const report = await updateStudentInfo(true, true)
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to update student information', details: error.message } }
    }
  }
})

app.http('updateStudentInfoDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/updateStudentInfo',
  handler: async (request, context) => {
    try {
      const report = await updateStudentInfo(true, true)
      return { status: 200, jsonBody: report }
    } catch (error) {
      return { status: 500, jsonBody: { error: 'Failed to update student information', details: error.message } }
    }
  }
})