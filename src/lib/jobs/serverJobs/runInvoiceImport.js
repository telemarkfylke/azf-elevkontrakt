(async () => {
  require('dotenv').config()
  const { logger } = require('@vtfk/logger')
  const { generateInvoiceImportFile, sendImportFailureAlert } = require('./xledgerInvoiceImport')

  logger('info', ['Starting generateInvoiceImportFile job'])

  let statusInvoice
  try {
    statusInvoice = await generateInvoiceImportFile('normalInvoice', [])
  } catch (error) {
    // Without this, an Xledger import failure aborts status write-back for the whole batch with nobody aware -
    // the same documents get resent on the next scheduled run.
    logger('error', ['Error running generateInvoiceImportFile for normalInvoice', error])
    await sendImportFailureAlert('normalInvoice', error)
  }

  if (statusInvoice?.csvDataArray) {
    logger('info', [`Finished generateInvoiceImportFile job for invoices. Number of invoices imported: ${statusInvoice.csvDataArray.length}`])
  } else if (statusInvoice?.errors) {
    logger('error', ['Error response from Xledger:', statusInvoice])
  } else if (!statusInvoice) {
    logger('error', ['No invoices were imported, unknown error'])
  } else {
    logger('info', ['No invoices were imported'])
  }

  // Finished
  process.exit(1)
})()
