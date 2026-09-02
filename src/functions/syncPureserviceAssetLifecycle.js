const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { syncPureserviceAssetLifecycle } = require('../lib/jobs/syncPureserviceAssetLifecycle.js')

app.timer('syncPureserviceAssetLifecycle', {
  // Once daily at 21:00. Explicitly opts into real writes (dryRun: false) - the job function's
  // own default is a safe dry-run preview, see src/lib/jobs/syncPureserviceAssetLifecycle.js.
  schedule: '0 0 21 * * *',
  handler: async (myTimer, context) => {
    try {
      const report = await syncPureserviceAssetLifecycle(undefined, { dryRun: false })
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['syncPureserviceAssetLifecycle (timer)', 'Failed to sync Pureservice asset lifecycle', error])
      return { status: 500, jsonBody: { error: 'Failed to sync Pureservice asset lifecycle' } }
    }
  }
})

app.http('syncPureserviceAssetLifecycleDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/syncPureserviceAssetLifecycle',
  handler: async (request, context) => {
    try {
      const lookbackDaysParam = request.query.get('lookbackDays')
      const dryRunParam = request.query.get('dryRun')
      const pureserviceIdParam = request.query.get('pureserviceId')
      const options = {
        // Omitted entirely (not defaulted here) when absent, so the job function's own safe
        // default (dryRun: true) applies - hitting this endpoint with no params stays a preview.
        ...(lookbackDaysParam ? { lookbackDays: parseInt(lookbackDaysParam, 10) } : {}),
        ...(dryRunParam !== null ? { dryRun: dryRunParam !== 'false' } : {}),
        // Test against a single known user (skips discovery entirely), e.g. ?pureserviceId=345
        ...(pureserviceIdParam ? { pureserviceId: parseInt(pureserviceIdParam, 10) } : {})
      }
      const report = await syncPureserviceAssetLifecycle(undefined, options)
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['syncPureserviceAssetLifecycleDev', 'Failed to sync Pureservice asset lifecycle', error])
      // Dev-only endpoint (anonymous, /dev/ route) - surface the real error message here too,
      // not just in the log, so a local test run doesn't require digging through the console.
      // error.response?.data is Pureservice's own validation detail (e.g. a filter type error) -
      // axios's error.message just says "Request failed with status code 400" either way.
      return {
        status: 500,
        jsonBody: {
          error: 'Failed to sync Pureservice asset lifecycle',
          message: error.message,
          pureserviceError: error.response?.data,
          stack: error.stack
        }
      }
    }
  }
})
