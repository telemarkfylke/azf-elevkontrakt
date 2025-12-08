(async () => {
    require('dotenv').config()
    const { logger } = require('@vtfk/logger')
    const { generateInvoiceImportFile } = require('./xledgerInvoiceImport')

    logger('info', ['Starting generateInvoiceImportFile job'])

    const statusInvoice = await generateInvoiceImportFile()

    if(statusInvoice?.csvDataArray) {
        logger('info', [`Finished generateInvoiceImportFile job for invoices. Number of invoices imported: ${statusInvoice.csvDataArray.length}`])
    } else if (statusInvoice?.errors){
        logger('error', ['Error response from Xledger:', statusInvoice])
    } else if (!statusInvoice) {
        logger('error', ['No invoices were imported, unknown error'])
    } else {
        logger('info', ['No invoices were imported'])
    }

    // Finished
    process.exit(1)
})()