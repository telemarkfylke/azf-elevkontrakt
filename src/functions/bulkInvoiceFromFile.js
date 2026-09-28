const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { decodeToken } = require('../lib/auth/decodeToken.js')
const { bulkInvoiceFromFile } = require('../lib/jobs/bulkInvoiceFromFile.js')
const { runExists } = require('../lib/jobs/bulkRunStore.js')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Bulk-invoices the remaining unpaid rates for a list of students uploaded as a CSV file.
 *
 * multipart/form-data, read with request.formData() - built into @azure/functions v4, so no
 * multipart parser and no new dependency.
 *
 *   file         the CSV (required)
 *   mode         'boughtOut' (every remaining unpaid rate, marks the contract bought out)
 *                | 'oneTime'  (the first unpaid rate only, leaves pcInfo alone)
 *   collections  comma-separated subset of 'regular,pcIkkeInnlevert' (default: both)
 *   fnrColumn    optional header-name override for the fødselsnummer column
 *   userInfo     optional JSON, same shape the cart flow posts, stamped on every invoice
 *   dryRun       writes happen ONLY on the literal string 'false'
 *
 * The dryRun default lives in the job, not here: when the field is absent the key is omitted
 * entirely so the job's own `dryRun = true` applies. Same convention as the dev/ job routes
 * (archiveResolvedPcIkkeInnlevert.js) - posting this endpoint by accident previews, it does not bill.
 *
 * Status codes are the contract a frontend branches on, via the report's `fatal.reason`:
 *
 * A run outlives its response: Azure cuts the body at ~230 s and a large file takes minutes. Every
 * response carries runId, and the caller may supply its own so it can poll
 * GET /api/invoice/bulkRuns/{runId} from the moment it submits.
 *
 *   200 -> the run completed; read the report for what was and was not done
 *   400 -> the request could not be acted on at all (no file, bad mode/collections, no fnr column)
 *   400 -> also when the file is not a CSV (reason: invalid-file-type)
 *   403 -> missing role
 *   409 -> the supplied runId has already been used
 *   500 -> unexpected failure
 *
 * A 200 is NOT "everything worked" - a run where every student failed is still a completed run, and
 * the per-student buckets are where that shows. See docs/bulk-invoice-from-file.md.
 */
app.http('bulkInvoiceFromFile', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'invoice/bulkFromFile',
  handler: async (request, context) => {
    const logPrefix = 'bulkInvoiceFromFile'
    const authorizationHeader = request.headers.get('authorization')

    // Narrowest role that fits: this bills hundreds of students in one call.
    if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
      logger('error', [logPrefix, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    let formData
    try {
      formData = await request.formData()
    } catch (error) {
      logger('error', [logPrefix, 'Kunne ikke lese multipart/form-data', error.message])
      return { status: 400, jsonBody: { error: 'Forventet multipart/form-data med et felt "file"', reason: 'invalid-form-data' } }
    }

    const file = formData.get('file')
    if (!file || typeof file.text !== 'function') {
      logger('error', [logPrefix, 'Mangler filfeltet "file"'])
      return { status: 400, jsonBody: { error: 'Mangler filen. Send CSV-filen i feltet "file"', reason: 'missing-file' } }
    }

    // Reject non-CSV files by name, but do not try to sniff the content. The job will fail on a non-CSV anyway.
    if (typeof file.name === 'string' && file.name && !file.name.toLowerCase().endsWith('.csv')) {
      logger('error', [logPrefix, `Avviste filtypen: ${file.name}`])
      return { status: 400, jsonBody: { error: `«${file.name}» er ikke en CSV-fil. Lagre fila som CSV og prøv igjen.`, reason: 'invalid-file-type' } }
    }

    let csvText
    try {
      csvText = await file.text()
    } catch (error) {
      logger('error', [logPrefix, 'Kunne ikke lese innholdet i filen', error.message])
      return { status: 400, jsonBody: { error: 'Kunne ikke lese innholdet i filen', reason: 'unreadable-file' } }
    }

    // Supplied by a caller that wants to poll from the moment it submits. curl and Postman omit it.
    const suppliedRunId = formData.get('runId')
    if (suppliedRunId && !UUID_PATTERN.test(suppliedRunId)) {
      return { status: 400, jsonBody: { error: 'runId må være en UUID', reason: 'invalid-run-id' } }
    }
    if (suppliedRunId && await runExists(suppliedRunId)) {
      logger('error', [logPrefix, `runId ${suppliedRunId} er allerede brukt`])
      return { status: 409, jsonBody: { error: 'Denne kjøringen finnes allerede', reason: 'run-id-in-use' } }
    }

    const mode = formData.get('mode')
    const fnrColumn = formData.get('fnrColumn') || undefined
    const dryRunField = formData.get('dryRun')
    const collectionsField = formData.get('collections')

    let userInfo = {}
    const userInfoField = formData.get('userInfo')
    if (userInfoField) {
      try {
        userInfo = JSON.parse(userInfoField)
      } catch (error) {
        return { status: 400, jsonBody: { error: 'userInfo må være gyldig JSON', reason: 'invalid-user-info' } }
      }
    }

    // Falls back to the caller's own token so an invoice always records who asked for it, even when
    // no frontend supplied userInfo. Same shape handleBoughtOut builds for its automated caller.
    // Contained: validateRoles already decoded this token, but who created an invoice is not worth
    // failing the whole run over if the claim shape ever surprises us.
    let claims = {}
    try {
      claims = decodeToken(authorizationHeader?.split(' ')[1], ['upn', 'name']) ?? {}
    } catch (error) {
      logger('warn', [logPrefix, 'Kunne ikke lese brukerinfo fra token, bruker fallback', error.message])
    }
    const invoiceCreatedBy = {
      name: userInfo.displayName ?? claims.name ?? claims.upn ?? 'Ukjent',
      givenName: userInfo.givenName ?? null,
      surname: userInfo.surname ?? null,
      email: userInfo.userPrincipalName ?? claims.upn ?? null, 
      companyName: userInfo.companyName ?? 'Masseinnfakturering (fil)',
      officeLocation: userInfo.officeLocation ?? null,
      jobTitle: userInfo.jobTitle ?? null
    }

    const options = {
      csvText,
      mode,
      invoiceCreatedBy,
      ...(fnrColumn ? { fnrColumn } : {}),
      ...(collectionsField ? { collections: collectionsField.split(',').map(value => value.trim()).filter(Boolean) } : {}),
      // Omitted when absent so the job's dryRun = true default applies.
      ...(dryRunField !== null && dryRunField !== undefined ? { dryRun: dryRunField !== 'false' } : {}),
      ...(suppliedRunId ? { runId: suppliedRunId } : {})
    }

    let report
    try {
      report = await bulkInvoiceFromFile(undefined, options)
    } catch (error) {
      logger('error', [logPrefix, 'Uventet feil under fakturering fra fil', error.message, error.stack])
      return { status: 500, jsonBody: { error: 'Faktureringen fra fil feilet', reason: 'unexpected-error' } }
    }

    if (report.fatal) {
      logger('error', [logPrefix, `Avbrutt: ${report.fatal.reason} - ${report.fatal.message}`])
      return { status: 400, jsonBody: report }
    }

    logger('info', [logPrefix, `Ferdig - runId: ${report.runId}, dryRun: ${report.dryRun}, fakturert: ${report.totals.contracts}, hoppet over: ${report.skipped.length}, feil: ${report.errors.length}`])
    return { status: 200, jsonBody: report }
  }
})
