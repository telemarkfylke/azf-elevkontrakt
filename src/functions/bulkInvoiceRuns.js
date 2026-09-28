const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { readRun, readProgress, listRuns } = require('../lib/jobs/bulkRunStore.js')

/**
 * Reads back what a bulk-invoicing run did, and doubles as the poll endpoint while one is running.
 *
 * Same role as the run itself: the report carries the same unmasked fødselsnumre.
 *
 *   200 without runId -> the most recent runs, newest first
 *   200 with runId    -> the progress record while running, the full report once finished
 *   404               -> no such run, or its report has passed the retention window
 *   502               -> storage unreachable, which must not read as "that run never existed"
 */
app.http('bulkInvoiceRuns', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'invoice/bulkRuns/{runId?}',
  handler: async (request, context) => {
    const logPrefix = 'bulkInvoiceRuns'
    const authorizationHeader = request.headers.get('authorization')

    if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
      logger('error', [logPrefix, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    const { runId } = request.params

    try {
      if (!runId) {
        const limit = Number(request.query.get('limit')) || 25
        return { status: 200, jsonBody: { runs: await listRuns(limit) } }
      }

      // The full record is written last, so a finished run is answered from it and a live one from
      // the progress blob.
      const run = await readRun(runId)
      if (run && run.status !== 'started' && run.status !== 'running') {
        return { status: 200, jsonBody: run }
      }

      const progress = await readProgress(runId)
      if (progress) return { status: 200, jsonBody: progress }
      if (run) return { status: 200, jsonBody: run }

      return { status: 404, jsonBody: { error: 'Fant ingen kjøring med denne id-en', reason: 'run-not-found' } }
    } catch (error) {
      logger('error', [logPrefix, 'Kunne ikke lese kjøringen', error.message])
      return { status: 502, jsonBody: { error: 'Kunne ikke lese kjøringen. Prøv igjen.', reason: 'storage-unavailable' } }
    }
  }
})
