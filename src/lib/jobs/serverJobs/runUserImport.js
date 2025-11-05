(async () => {
    require('dotenv').config()
    const { logger } = require('@vtfk/logger')
    const { createCsvDataArray } = require('./xledgerUserImport')

    logger('info', ['Starting createCsvDataArray job'])

    logger('info', ['Updating student PC status for utlevering'])
    const statusUser = await createCsvDataArray()
    logger('info', [`Finished createCsvDataArray job for users. Number of users imported: ${statusUser.csvDataArray.length}`])

    // Finished
    process.exit(1)
})()