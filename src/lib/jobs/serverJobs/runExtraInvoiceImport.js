
(async () => {
  require('dotenv').config()
  const { logger } = require('@vtfk/logger')
  const { processInvoices } = require('./xledgerExtraInvoice')


  logger('info', ['Starting generateInvoiceImportFile job'])

  const statusInvoice = await processInvoices()

  if (statusInvoice?.extraInvoiceResults) {
    logger('info', [`Finished generateInvoiceImportFile job for invoices. Number of extra invoices imported: ${statusInvoice?.extraInvoiceResults?.csvDataArray.length} & Number of buyOut invoices imported: ${statusInvoice?.buyOutResults?.csvDataArray.length}`])
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
