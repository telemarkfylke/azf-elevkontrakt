const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { archiveResolvedPcIkkeInnlevert } = require('../lib/jobs/archiveResolvedPcIkkeInnlevert.js')

app.timer('archiveResolvedPcIkkeInnlevert', {
  // Once daily at 04:45, at the back of the early-morning chain rather than on top of it:
  // updatePaymentStatusPCNotDelivered (04:00) is the job that refreshes rate statuses in this very
  // collection, followed by updatePaymentStatusExtraInvoice (04:15) and updatePaymentStatusBuyOut
  // (04:30) - so this run sees all of their writes, plus the previous evening's
  // syncPureserviceAssetLifecycle (21:00) pcInfo backfill, and still lands before
  // updatePaymentStatus (05:00) and updateStudentInfo (06:00).
  // Explicitly opts into real writes (dryRun: false) - the job function's own default is a safe
  // dry-run preview, see src/lib/jobs/archiveResolvedPcIkkeInnlevert.js.
  schedule: '0 45 4 * * *',
  handler: async (myTimer, context) => {
    try {
      const report = await archiveResolvedPcIkkeInnlevert(undefined, { dryRun: false })
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['archiveResolvedPcIkkeInnlevert (timer)', 'Failed to archive resolved contracts', error])
      return { status: 500, jsonBody: { error: 'Failed to archive resolved contracts' } }
    }
  }
})

app.http('archiveResolvedPcIkkeInnlevertDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/archiveResolvedPcIkkeInnlevert',
  handler: async (request, context) => {
    try {
      const dryRunParam = request.query.get('dryRun')
      const options = {
        // default (dryRun: true) applies - hitting this endpoint with no params stays a preview.
        ...(dryRunParam !== null ? { dryRun: dryRunParam !== 'false' } : {})
      }
      const report = await archiveResolvedPcIkkeInnlevert(undefined, options)
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['archiveResolvedPcIkkeInnlevertDev', 'Failed to archive resolved contracts', error])
      // Dev-only endpoint
      return {
        status: 500,
        jsonBody: {
          error: 'Failed to archive resolved contracts',
          message: error.message,
          stack: error.stack
        }
      }
    }
  }
})
