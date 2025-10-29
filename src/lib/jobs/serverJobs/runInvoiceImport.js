(async () => {
    require('dotenv').config()
    const { logger } = require('@vtfk/logger')
    const { generateInvoiceImportFile } = require('./xledgerInvoiceImport')

    logger('info', ['Starting generateInvoiceImportFile job'])

    logger('info', ['Updating student PC status for utlevering'])
    const statusInvoice = await generateInvoiceImportFile()
    logger('info', [`Finished generateInvoiceImportFile job for invoices. Number of invoices imported: ${statusInvoice.csvDataArray.length}`])

    // Finished
    process.exit(1)
})()