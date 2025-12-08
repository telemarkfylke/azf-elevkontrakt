(async () => {
  require('dotenv').config()
  const { logger } = require('@vtfk/logger')
  const { createCsvDataArray } = require('./xledgerUserImport')

  logger('info', ['Starting createCsvDataArray job'])
  const statusUser = await createCsvDataArray()
  if (statusUser?.csvDataArray) {
    logger('info', [`Finished createCsvDataArray job for users. Number of users imported: ${statusUser?.csvDataArray?.length || 0}`])
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
