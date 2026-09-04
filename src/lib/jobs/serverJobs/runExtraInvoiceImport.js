
(async () => {
  require('dotenv').config()
  const { logger } = require('@vtfk/logger')
  const { processInvoices } = require('./xledgerExtraInvoice')
  const { sendImportFailureAlert } = require('./xledgerInvoiceImport')


  logger('info', ['Starting generateInvoiceImportFile job'])

  let statusInvoice
  try {
    statusInvoice = await processInvoices()
  } catch (error) {
    // Safety net for failures outside the per-type handling already inside processInvoices() (e.g. the initial MongoDB fetch).
    logger('error', ['Unexpected error running processInvoices', error])
    await sendImportFailureAlert('extraInvoice/buyOut', error)
  }

  if (statusInvoice?.extraInvoiceResults || statusInvoice?.buyOutResults) {
    // Optional chaining all the way down: a run with nothing to import returns no CSV rows, which used
    // to make this line a TypeError instead of a log message.
    logger('info', [`Finished generateInvoiceImportFile job for invoices. Number of extra invoices imported: ${statusInvoice?.extraInvoiceResults?.csvDataArray?.length ?? 0} & Number of buyOut invoices imported: ${statusInvoice?.buyOutResults?.csvDataArray?.length ?? 0}. Left alone (recipient not imported to Xledger): ${(statusInvoice?.extraInvoiceResults?.skippedNotImportedToXledger?.length ?? 0) + (statusInvoice?.buyOutResults?.skippedNotImportedToXledger?.length ?? 0)}`])
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
