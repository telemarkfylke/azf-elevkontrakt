const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { pruneExpiredRuns } = require('../lib/jobs/bulkRunStore.js')
const { bulkInvoice } = require('../../config')

/**
 * Enforces the retention window on stored run reports, which carry unmasked fødselsnumre.
 *
 * In code rather than an Azure lifecycle rule because no infrastructure in this repo is declared in
 * code - a portal setting would be invisible to anyone reading this.
 *
 * At 05:15, behind the early-morning chain that ends with archiveResolvedPcIkkeInnlevert at 04:45.
 */
app.timer('pruneBulkInvoiceRuns', {
  schedule: '0 15 5 * * *',
  handler: async (myTimer, context) => {
    const logPrefix = 'pruneBulkInvoiceRuns'
    try {
      const { deleted, failed } = await pruneExpiredRuns(bulkInvoice.runRetentionDays)
      logger('info', [logPrefix, `Ferdig - slettet: ${deleted}, feilet: ${failed}, oppbevaring: ${bulkInvoice.runRetentionDays} dager`])
    } catch (error) {
      logger('error', [logPrefix, `Kunne ikke rydde kjøringsrapporter: ${error.message}`])
      throw error
    }
  }
})
