'use strict'

/**
 * Archives contracts that have become resolved while sitting in
 * 'historiske-avtaler-pc-ikke-innlevert', moving them on to 'historiske-avtaler'.
 *
 * Why this job exists:
 * updateStudentInfo (updateStudentInfo.js) is the only automated router *into* that collection -
 * when a student disappears from FINT it asks determineHistoryMoveTarget (contractChecks.js)
 * where the contract belongs, and anything with an unreturned PC or an unresolved invoice ends up
 * in 'historiske-avtaler-pc-ikke-innlevert' rather than 'historiske-avtaler'.
 *
 * That routing decision was never revisited. Several jobs keep writing to those documents in
 * place afterwards - updatePaymentStatus('pcIkkeInnlevert') flips rates to 'Betalt'/'Kreditert',
 * syncPureserviceAssetLifecycle and updatePCStatus backfill pcInfo.returned/boughtOut - so a
 * contract routinely *becomes* eligible for 'historiske-avtaler' after it was archived, and
 * nothing noticed. Until this job, the only way out was a human hitting
 * DELETE /api/handleDbRequest from the admin UI, which also meant a stranded document kept its
 * Pureservice link forever (only moveAndDeleteDocument's 'historic' branch resets cf_2).
 *
 * Eligibility itself is determineHistoryMoveTarget's call, not this job's, so the inbound router
 * and this outbound sweep can never disagree about where a contract belongs. On top of that rule
 * both paths apply the invoices-collection gate (invoiceChecks.js), which catches what the rule
 * structurally cannot see: an unpaid extraInvoice has no counterpart in fakturaInfo.
 */

const { logger } = require('@vtfk/logger')
const { getDocuments, moveAndDeleteDocument } = require('./queryMongoDB')
const { determineHistoryMoveTarget, FULLY_PAID_RATE_STATUSES } = require('./contractChecks.js')
const { isInvoiceSettled, describeInvoice, fetchInvoicesByContract } = require('./invoiceChecks.js')
const { teams } = require('../../../config.js')
const axios = require('axios').default

const RATE_KEYS = ['rate1', 'rate2', 'rate3']

/**
 * determineHistoryMoveTarget can only return 'historic' for a contract that was returned, bought
 * out, or fully paid, so this is exactly the candidate set - no point fetching (and re-deciding
 * on) the rest of the collection every night. The fully-paid branch mirrors that rule's own
 * status list, imported rather than repeated so the query and the rule cannot drift apart.
 */
const CANDIDATE_QUERY = {
  $or: [
    { 'pcInfo.returned': 'true' },
    { 'pcInfo.boughtOut': 'true' },
    { $and: RATE_KEYS.map(key => ({ [`fakturaInfo.${key}.status`]: { $in: FULLY_PAID_RATE_STATUSES } })) }
  ]
}

/**
 * determineHistoryMoveTarget dereferences doc.pcInfo.returned and doc.fakturaInfo.rateN.status
 * unguarded. One malformed document would otherwise throw and abort the whole sweep, so they get
 * identified up front and reported instead.
 */
const isDecidable = (doc) => Boolean(doc?.pcInfo) && RATE_KEYS.every(key => doc?.fakturaInfo?.[key]?.status !== undefined)

const describeDocument = (doc) => ({
  documentId: doc._id.toString(),
  navn: doc.elevInfo?.navn,
  kontraktType: doc.unSignedskjemaInfo?.kontraktType
})

/**
 * Posts the run summary to Teams, same webhook/card style as updateStudentInfo. Deliberately not
 * called for a dry run - the dev endpoint is meant to be pokeable without notifying anyone.
 */
const postTeamsReport = async (report) => {
  const logPrefix = 'archiveResolvedPcIkkeInnlevert - postTeamsReport'
  if (!teams.webhook) {
    logger('info', [logPrefix, 'No Teams webhook configured, skipping report'])
    return
  }
  const teamsMsg = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          msteams: { width: 'full' },
          body: [
            {
              type: 'TextBlock',
              text: 'Statusrapport - azf-elevkontrakt - Arkivering av oppgjorte avtaler fra "pc ikke innlevert"',
              wrap: true,
              style: 'heading'
            },
            {
              type: 'TextBlock',
              text: `**${report.candidates}** avtale(r) med innlevert, utkjøpt eller fullt betalt pc ble vurdert`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `**${report.archived.length}** avtale(r) er ferdig oppgjort og ble flyttet til historikk-databasen`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: report.archived.map(entry => ({ title: entry.navn || entry.documentId, value: entry.documentId }))
            },
            {
              type: 'TextBlock',
              text: `**${report.skippedStillUnresolved.length}** avtale(r) ble stående fordi de har utestående fakturaer`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `**${report.skippedUnsettledInvoices.length}** avtale(r) ble stående fordi de har uoppgjorte fakturaer i fakturasamlingen`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: report.skippedUnsettledInvoices.map(entry => ({ title: entry.navn || entry.documentId, value: entry.invoices.map(invoice => `${invoice.type}: ${invoice.status}`).join('; ') }))
            },
            {
              type: 'TextBlock',
              text: `**${report.skippedIncomplete.length}** avtale(r) mangler pcInfo eller fakturaInfo og må ses på manuelt`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: report.skippedIncomplete.map(entry => ({ title: entry.navn || entry.documentId, value: entry.documentId }))
            },
            {
              type: 'TextBlock',
              text: `**${report.errors.length}** avtale(r) feilet under flytting`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: report.errors.map(entry => ({ title: entry.documentId, value: entry.error }))
            }
          ]
        }
      }
    ]
  }
  const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
  await axios.post(teams.webhook, teamsMsg, { headers })
}

/**
 * Re-runs determineHistoryMoveTarget over 'historiske-avtaler-pc-ikke-innlevert' and moves every
 * now-resolved contract with no outstanding invoice on to 'historiske-avtaler'. Defaults to a
 * dry-run preview - real callers (the timer trigger) opt in explicitly with { dryRun: false }.
 * @param {Object} [deps]
 * @param {Function} [deps.getDocumentsFn]
 * @param {Function} [deps.moveAndDeleteDocumentFn]
 * @param {Function} [deps.postTeamsReportFn]
 * @param {Object} [options]
 * @param {boolean} [options.dryRun] - true (default): preview only, no writes and no Teams report
 * @returns {Promise<{dryRun: boolean, candidates: number, archived: Array, skippedStillUnresolved: Array, skippedUnsettledInvoices: Array, skippedIncomplete: Array, errors: Array}>}
 */
const archiveResolvedPcIkkeInnlevert = async (deps = {}, options = {}) => {
  const {
    getDocumentsFn = getDocuments,
    moveAndDeleteDocumentFn = moveAndDeleteDocument,
    postTeamsReportFn = postTeamsReport
  } = deps
  const { dryRun = true } = options

  const logPrefix = 'archiveResolvedPcIkkeInnlevert'
  const report = {
    dryRun,
    candidates: 0,
    archived: [],
    skippedStillUnresolved: [],
    skippedUnsettledInvoices: [],
    skippedIncomplete: [],
    errors: []
  }

  logger('info', [logPrefix, `Starting sweep of historiske-avtaler-pc-ikke-innlevert, dryRun: ${dryRun}`])

  const documents = await getDocumentsFn(CANDIDATE_QUERY, 'pcIkkeInnlevert')
  // getDocuments answers 404 (not an empty result array) when nothing matches
  if (documents.status !== 200 || !documents.result?.length) {
    logger('info', [logPrefix, `No contracts with a returned or bought-out pc in historiske-avtaler-pc-ikke-innlevert (status ${documents.status})`])
    return report
  }

  report.candidates = documents.result.length
  logger('info', [logPrefix, `${report.candidates} returned, bought-out or fully paid contract(s) to evaluate`])

  const invoicesByContract = await fetchInvoicesByContract(documents.result, getDocumentsFn)
  logger('info', [logPrefix, `${invoicesByContract.size} of them have invoice(s) in the invoices collection`])

  // Sequential, not Promise.all: each move to 'historic' resets cf_2 in Pureservice via patchUser,
  // and a mass return can put hundreds of documents in here at once - same reasoning as
  // syncPureserviceAssetLifecycle, see docs/pureservice-asset-lifecycle.md#rate-limiting.
  for (const doc of documents.result) {
    const summary = describeDocument(doc)

    if (!isDecidable(doc)) {
      logger('warn', [logPrefix, `Document ${summary.documentId} is missing pcInfo or fakturaInfo rate statuses, cannot decide - skipping`])
      report.skippedIncomplete.push(summary)
      continue
    }

    const rateStatuses = RATE_KEYS.map(key => doc.fakturaInfo[key].status)

    if (determineHistoryMoveTarget(doc) !== 'historic') {
      // The rate statuses are the whole explanation for why it stayed put ('Fakturert' and
      // 'Overført inkasso' being the usual blockers), so carry them into the report.
      logger('info', [logPrefix, `Document ${summary.documentId} is still unresolved, leaving it in place - rates: ${rateStatuses.join(', ')}`])
      report.skippedStillUnresolved.push({ ...summary, rateStatuses })
      continue
    }

    // The contract's own fakturaInfo says it is settled - but an extraInvoice (a damage charge,
    // say) has no counterpart in fakturaInfo at all, so an unpaid one is invisible to the rule
    // above. Nothing leaves the holding pen while any invoice is still outstanding.
    const unsettledInvoices = (invoicesByContract.get(String(doc._id)) ?? []).filter(invoice => !isInvoiceSettled(invoice))
    if (unsettledInvoices.length > 0) {
      const invoices = unsettledInvoices.map(describeInvoice)
      logger('info', [logPrefix, `Document ${summary.documentId} has ${invoices.length} unsettled invoice(s), leaving it in place - ${invoices.map(invoice => `${invoice.type}: ${invoice.status}`).join('; ')}`])
      report.skippedUnsettledInvoices.push({ ...summary, rateStatuses, invoices })
      continue
    }

    try {
      if (!dryRun) {
        const moveResult = await moveAndDeleteDocumentFn(doc._id, 'historic', 'pcIkkeInnlevert')
        if (moveResult.status !== 200) {
          // Includes the 502 raised when the Pureservice cf_2 reset fails - the move is aborted in
          // that case, so the document is still here and will be retried on the next run.
          logger('error', [logPrefix, `Failed to move document ${summary.documentId} to historiske-avtaler`, JSON.stringify(moveResult)])
          report.errors.push({ ...summary, error: moveResult.error || `moveAndDeleteDocument returned status ${moveResult.status}` })
          continue
        }
      }
      report.archived.push({ ...summary, rateStatuses, moved: !dryRun })
      logger('info', [logPrefix, `${dryRun ? '[DRY RUN] Would archive' : 'Archived'} document ${summary.documentId} to historiske-avtaler`])
    } catch (error) {
      logger('error', [logPrefix, `Unexpected error moving document ${summary.documentId}`, error])
      report.errors.push({ ...summary, error: error.message })
    }
  }

  logger('info', [logPrefix, `Finished (dryRun=${dryRun}) - ${report.archived.length} archived, ${report.skippedStillUnresolved.length} still unresolved, ${report.skippedUnsettledInvoices.length} with unsettled invoices, ${report.skippedIncomplete.length} undecidable, ${report.errors.length} errors`])

  if (!dryRun) {
    try {
      await postTeamsReportFn(report)
    } catch (error) {
      // A failed report must not fail the run - the moves already happened.
      logger('error', [logPrefix, 'Failed to post Teams report', error])
    }
  }

  return report
}

module.exports = {
  archiveResolvedPcIkkeInnlevert,
  postTeamsReport,
  isDecidable,
  CANDIDATE_QUERY
}
