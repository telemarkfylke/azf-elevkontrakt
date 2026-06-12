const { logger } = require('@vtfk/logger')
const { getDocuments, updateDocument } = require('./queryMongoDB')
const { getAllStudents } = require('./queryPureservice')

const syncPureserviceStudents = async (collection) => {
  const logPrefix = 'syncPureserviceStudents'
  const report = {
    total: 0,
    updated: 0,
    skipped: 0,
    notFound: 0
  }

  logger('info', [logPrefix, 'Starting Pureservice student ID sync'])

  // Fetch all Pureservice students in one paginated call
  const pusStudents = await getAllStudents()
  logger('info', [logPrefix, `Fetched ${pusStudents.length} students from Pureservice`])

  // Build email (lowercase) → pusId map
  const emailToPusId = new Map()
  for (const student of pusStudents) {
    for (const email of student.emails) {
      emailToPusId.set(email.toLowerCase(), student.pusId)
    }
  }

  // Fetch all contracts from MongoDB
  const { result: contracts } = await getDocuments({}, collection)
  report.total = contracts.length
  logger('info', [logPrefix, `Found ${contracts.length} contracts in MongoDB`])

  for (const contract of contracts) {
    const upn = contract.elevInfo?.upn
    if (!upn || upn === 'Ukjent') {
      report.skipped++
      continue
    }

    const pusId = emailToPusId.get(upn.toLowerCase())
    if (!pusId) {
      logger('info', [logPrefix, `No Pureservice match for UPN: ${upn}`])
      report.notFound++
      continue
    }

    if (contract.pureserviceId === pusId) {
      report.skipped++
      continue
    }

    await updateDocument(contract._id, { pureserviceId: pusId }, collection)
    logger('info', [logPrefix, `Updated contract ${contract._id} with pureserviceId ${pusId} (upn: ${upn})`])
    report.updated++
  }

  logger('info', [logPrefix, `Sync complete — total: ${report.total}, updated: ${report.updated}, skipped: ${report.skipped}, notFound: ${report.notFound}`])
  return report
}

module.exports = { syncPureserviceStudents }
