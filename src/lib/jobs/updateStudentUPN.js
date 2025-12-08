const { logger } = require('@vtfk/logger')
const { student } = require('./queryFINT')
const { getDocuments, updateDocument } = require('./queryMongoDB')

/*
 * Update the UPN (User Principal Name) for a student document in the database.
 *
 * This functions fetches all the documents that needs to be updated and updates the UPN.
 * Retrieves the student's details from FINT and updates the UPN in the document.
 *
 * This function is intended to be run as a job, after the IDM job is finished and all the students have been created in entraID.
 * It should only be run once after the IDM job is finished or if some students are missing UPN later on.
 *
 */
const updateStudentUPN = async () => {
  const loggerPrefix = 'updateStudentUPN'
  logger('info', [loggerPrefix, 'Starting update of student UPN'])
  const query = {
    'elevInfo.upn': 'Ukjent'
  }

  const documents = await getDocuments(query, 'regular')

  /**
    * For each document, we will fetch the student data from FINT and update the UPN.
    */
  let updateCount = 0
  for (const doc of documents.result) {
    const studentData = await student(doc.elevInfo.fnr, false)
    if (studentData) {
      if (doc.elevInfo.upn !== studentData.upn) {
        logger('info', [loggerPrefix, `Updating UPN from ${doc.elevInfo.upn} to ${studentData.upn}`])
        await updateDocument(doc._id, { 'elevInfo.upn': studentData.upn }, 'regular')
      } else {
        logger('info', [loggerPrefix, `UPN is already up to date for student with UPN: ${doc.elevInfo.upn}`])
      }
    }
    updateCount++
  }
  logger('info', [loggerPrefix, `Updated UPN for ${updateCount} students`])
  return updateCount
}

module.exports = {
  updateStudentUPN
}
