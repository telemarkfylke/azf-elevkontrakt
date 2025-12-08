(async () => {
  require('dotenv').config()
  const { logger } = require('@vtfk/logger')
  const { resetUserImportStatus } = require('./xledgerResetUserImportStatus')

  logger('info', ['Starting resetUserImportStatus job'])

  const statusUser = await resetUserImportStatus()

  if (statusUser?.message) {
    logger('info', [`Finished resetUserImportStatus job for users. Number of users imported: ${statusUser.message}`])
  } else if (statusUser?.errors) {
    logger('error', ['Error response from Xledger:', statusUser])
  } else if (!statusUser) {
    logger('error', ['No users were imported, unknown error'])
  } else {
    logger('info', ['No users were imported'])
  }

  // Finished
  process.exit(1)
})()
