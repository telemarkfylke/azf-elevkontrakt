'use strict'

const { logger } = require('@vtfk/logger')
const { getDocuments, updateContractPCStatus } = require('./queryMongoDB')
const { getUser, getCompletedAssetRegistrations, getRecentlyCreatedAssetRegistrations } = require('./queryPureservice.js')
const { getPcPossessionStatus, PC_ASSET_TYPE_IDS } = require('./pureserviceAssetLifecycle.js')
const { findContractByPureserviceId, targetCollectionFor } = require('./updatePCStatus.js')
const { createBuyOutInvoice } = require('./processInvoices.js')
const { getThisYearsPriceList } = require('../helpers/getSettings.js')
const { returnCorrectPriceForStudent } = require('../helpers/getCorrectRatePrice.js')

const DEFAULT_LOOKBACK_DAYS = 3
const RETURNED_REASON_ID = 11
const BOUGHT_OUT_REASON_ID = 14

/**
 * Best-effort resolution of a Pureservice user ID to an email, for use as the pcInfo "who did
 * this" actor. Falls back to a clearly-labeled sentinel on any failure or unexpected response
 * shape (the single-user response shape hasn't been live-verified against this exact `include`).
 * @param {number} pureserviceUserId
 * @param {Object} [deps]
 * @param {Function} [deps.getUserFn]
 */
const resolveActorEmail = async (pureserviceUserId, deps = {}) => {
  const { getUserFn = getUser } = deps
  const logPrefix = 'syncPureserviceAssetLifecycle - resolveActorEmail'
  try {
    const response = await getUserFn(pureserviceUserId, 'emailaddresses')
    const email = response?.linked?.emailaddresses?.[0]?.email
    if (email) return email
    logger('warn', [logPrefix, `No email found for Pureservice user ${pureserviceUserId}, using fallback sentinel`])
  } catch (error) {
    logger('warn', [logPrefix, `Failed to resolve Pureservice user ${pureserviceUserId}, using fallback sentinel`, error])
  }
  return `pureservice-agent-${pureserviceUserId}`
}

/**
 * Backfill safety net for a missed/failed "utlevering" call to updatePCStatus - only fires when
 * Pureservice shows the user currently has a PC but the contract was never marked released.
 * @returns {Promise<Object|null>} - the action taken/previewed, or null if already marked (skip)
 */
const handleReleased = async (contract, documentType, actorEmail, dryRun, deps = {}) => {
  const { updateContractPCStatusFn = updateContractPCStatus } = deps
  const logPrefix = 'syncPureserviceAssetLifecycle - handleReleased'

  if (contract.pcInfo?.released === 'true') {
    logger('info', [logPrefix, `Contract ${contract._id} already marked released, skipping`])
    return null
  }

  const action = { action: 'release', contractId: contract._id.toString(), actorEmail }
  if (!dryRun) {
    await updateContractPCStatusFn({ contractID: contract._id.toString(), releasePC: 'true', upn: actorEmail }, false, targetCollectionFor(documentType))
  }
  return action
}

/**
 * @returns {Promise<Object|null>} - the action taken/previewed, or null if already marked (skip)
 */
const handleReturned = async (contract, documentType, actorEmail, dryRun, deps = {}) => {
  const { updateContractPCStatusFn = updateContractPCStatus } = deps
  const logPrefix = 'syncPureserviceAssetLifecycle - handleReturned'

  if (contract.pcInfo?.returned === 'true') {
    logger('info', [logPrefix, `Contract ${contract._id} already marked returned, skipping`])
    return null
  }

  const action = { action: 'return', contractId: contract._id.toString(), actorEmail }
  if (!dryRun) {
    await updateContractPCStatusFn({ contractID: contract._id.toString(), returnPC: 'true', upn: actorEmail }, false, targetCollectionFor(documentType))
  }
  return action
}

/**
 * Marks the contract bought out (once, if not already) and always attempts to invoice any
 * remaining unpaid rates - the invoicing attempt is intentionally not gated on the pcInfo flag,
 * so a failed attempt on a prior run gets retried here even though the flag is already set.
 * @returns {Promise<Array<Object>>} - the action(s) taken/previewed (0-2 entries)
 */
const handleBoughtOut = async (contract, documentType, actorEmail, dryRun, deps = {}) => {
  const {
    updateContractPCStatusFn = updateContractPCStatus,
    getThisYearsPriceListFn = getThisYearsPriceList,
    createBuyOutInvoiceFn = createBuyOutInvoice
  } = deps
  const logPrefix = 'syncPureserviceAssetLifecycle - handleBoughtOut'
  const actions = []

  if (contract.pcInfo?.boughtOut === 'true') {
    logger('info', [logPrefix, `Contract ${contract._id} already marked boughtOut, skipping pcInfo write`])
  } else {
    const action = { action: 'boughtOut', contractId: contract._id.toString(), actorEmail }
    if (!dryRun) {
      await updateContractPCStatusFn({ contractID: contract._id.toString(), buyOutPC: 'true', upn: actorEmail }, false, targetCollectionFor(documentType))
    }
    actions.push(action)
  }

  const unpaidRates = ['rate1', 'rate2', 'rate3']
    .map(key => contract.fakturaInfo?.[key])
    .filter(rate => rate?.status === 'Ikke Fakturert')

  if (unpaidRates.length === 0) {
    logger('info', [logPrefix, `No unpaid rates left to invoice for contract ${contract._id}`])
    return actions
  }

  const { prices, exceptionsFromRegularPrices } = await getThisYearsPriceListFn()
  const items = unpaidRates.map(rate => ({
    faktureringsår: rate.faktureringsår,
    sum: returnCorrectPriceForStudent(contract.elevInfo?.fnr, contract.elevInfo?.klasse, prices, exceptionsFromRegularPrices)
  }))
  const total = items.reduce((sum, item) => sum + Number(item.sum), 0)

  if (dryRun) {
    actions.push({ action: 'buyOutInvoice', contractId: contract._id.toString(), items, total })
    return actions
  }

  const invoiceCreatedBy = {
    name: actorEmail,
    givenName: null,
    surname: null,
    email: actorEmail,
    companyName: 'Pureservice (automatisk)',
    officeLocation: null,
    jobTitle: null
  }
  const result = await createBuyOutInvoiceFn(contract, items, documentType, invoiceCreatedBy)
  if (result.status !== 200) {
    logger('error', [logPrefix, `createBuyOutInvoice failed for contract ${contract._id}: ${result.status} ${result.body}`])
  } else {
    actions.push({ action: 'buyOutInvoice', contractId: contract._id.toString(), items, total })
  }
  return actions
}

const isPcTypeRegistration = (registration, linked) => {
  const asset = linked.assets?.find(a => a.id === registration.assetId)
  return PC_ASSET_TYPE_IDS.includes(asset?.typeId)
}

/**
 * Bulk-checks which of a set of Pureservice userIds still need work for a given pcInfo flag
 * (haven't already been marked by the normal flow), across both contract collections, in one
 * Mongo round-trip per collection instead of one per candidate.
 */
const preFilterCandidates = async (userIds, flagField, getDocumentsFn) => {
  if (userIds.length === 0) return new Set()
  const query = { pureserviceId: { $in: userIds }, [flagField]: { $ne: 'true' } }
  const [regularResult, historicResult] = await Promise.all([
    getDocumentsFn(query, 'regular'),
    getDocumentsFn(query, 'pcIkkeInnlevert')
  ])
  const matched = new Set()
  if (regularResult.status === 200) regularResult.result.forEach(doc => matched.add(doc.pureserviceId))
  if (historicResult.status === 200) historicResult.result.forEach(doc => matched.add(doc.pureserviceId))
  return matched
}

/**
 * Syncs Pureservice PC lifecycle events (released/returned/boughtOut) onto contracts, and
 * auto-invoices remaining unpaid rates on buyout. Defaults to a dry-run preview - real callers
 * (the timer trigger) opt in explicitly with { dryRun: false }.
 * @param {Object} [deps]
 * @param {Object} [options]
 * @param {number} [options.lookbackDays] - how far back to look for Pureservice events
 * @param {boolean} [options.dryRun] - true (default): preview only, no writes
 * @param {number} [options.pureserviceId] - if set, skip discovery entirely and process only
 *   this one Pureservice user - for testing against a single known user
 * @returns {Promise<{released: Array, returned: Array, boughtOut: Array, skipped: Array, errors: Array, dryRun: boolean}>}
 */
const syncPureserviceAssetLifecycle = async (deps = {}, options = {}) => {
  const {
    getCompletedAssetRegistrationsFn = getCompletedAssetRegistrations,
    getRecentlyCreatedAssetRegistrationsFn = getRecentlyCreatedAssetRegistrations,
    getDocumentsFn = getDocuments,
    getPcPossessionStatusFn = getPcPossessionStatus,
    findContractByPureserviceIdFn = findContractByPureserviceId,
    resolveActorEmailFn = resolveActorEmail,
    updateContractPCStatusFn = updateContractPCStatus,
    getThisYearsPriceListFn = getThisYearsPriceList,
    createBuyOutInvoiceFn = createBuyOutInvoice,
    handleReleasedFn = handleReleased,
    handleReturnedFn = handleReturned,
    handleBoughtOutFn = handleBoughtOut
  } = deps
  // Threaded into whichever handler runs below, so overriding e.g. updateContractPCStatusFn at
  // the orchestrator level reaches the real handlers without also having to override them.
  const handlerDeps = { updateContractPCStatusFn, getThisYearsPriceListFn, createBuyOutInvoiceFn }
  const { lookbackDays = DEFAULT_LOOKBACK_DAYS, dryRun = true, pureserviceId } = options

  const logPrefix = 'syncPureserviceAssetLifecycle'
  const sinceISO = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()

  const summary = { released: [], returned: [], boughtOut: [], skipped: [], errors: [], dryRun }

  let candidateUserIds
  if (pureserviceId !== undefined) {
    logger('info', [logPrefix, `Testing against a single Pureservice user: ${pureserviceId} (skipping discovery), dryRun: ${dryRun}`])
    candidateUserIds = new Set([pureserviceId])
  } else {
    logger('info', [logPrefix, `Starting sync - lookbackDays: ${lookbackDays}, since: ${sinceISO}, dryRun: ${dryRun}`])

    // --- Discovery (3 fixed calls - not the per-user work the rate-limit concern is about) ---
    const returnedRegs = await getCompletedAssetRegistrationsFn({ completedReasonId: RETURNED_REASON_ID, sinceISO })
    const boughtOutRegs = await getCompletedAssetRegistrationsFn({ completedReasonId: BOUGHT_OUT_REASON_ID, sinceISO })
    const recentlyCreatedRegs = await getRecentlyCreatedAssetRegistrationsFn({ sinceISO })

    const returnedUserIds = [...new Set(returnedRegs.assetregistrations.filter(r => isPcTypeRegistration(r, returnedRegs.linked)).map(r => r.userId))]
    const boughtOutUserIds = [...new Set(boughtOutRegs.assetregistrations.filter(r => isPcTypeRegistration(r, boughtOutRegs.linked)).map(r => r.userId))]
    const releasedUserIds = [...new Set(
      recentlyCreatedRegs.assetregistrations
        .filter(r => r.completed === null)
        .filter(r => isPcTypeRegistration(r, recentlyCreatedRegs.linked))
        .map(r => r.userId)
    )]

    // --- Efficiency pre-filter (Mongo-only, no Pureservice calls - safe to run concurrently) ---
    const [releasedCandidates, returnedCandidates, boughtOutCandidates] = await Promise.all([
      preFilterCandidates(releasedUserIds, 'pcInfo.released', getDocumentsFn),
      preFilterCandidates(returnedUserIds, 'pcInfo.returned', getDocumentsFn),
      preFilterCandidates(boughtOutUserIds, 'pcInfo.boughtOut', getDocumentsFn)
    ])

    candidateUserIds = new Set([...releasedCandidates, ...returnedCandidates, ...boughtOutCandidates])
    logger('info', [logPrefix, `${candidateUserIds.size} candidate user(s) after discovery + pre-filter (from ${returnedUserIds.length} returned, ${boughtOutUserIds.length} boughtOut, ${releasedUserIds.length} recently-created raw hits)`])
  }

  // --- Per-user work: strictly sequential, one Pureservice possession check + actor
  // resolution per candidate, to avoid a concurrent burst against the 100 req/min limit ---
  for (const userId of candidateUserIds) {
    try {
      const status = await getPcPossessionStatusFn(userId)
      const { contract, documentType } = await findContractByPureserviceIdFn(userId, { getDocumentsFn })

      if (!contract) {
        logger('warn', [logPrefix, `No contract found for Pureservice user ${userId}, skipping`])
        summary.skipped.push({ userId, reason: 'no-contract' })
        continue
      }

      if (status.status === 'has') {
        const actorEmail = await resolveActorEmailFn(status.createdById)
        const result = await handleReleasedFn(contract, documentType, actorEmail, dryRun, handlerDeps)
        if (result) summary.released.push(result)
        else summary.skipped.push({ userId, reason: 'already-released' })
      } else if (status.status === 'returned') {
        const actorEmail = await resolveActorEmailFn(status.completedById)
        const result = await handleReturnedFn(contract, documentType, actorEmail, dryRun, handlerDeps)
        if (result) summary.returned.push(result)
        else summary.skipped.push({ userId, reason: 'already-returned' })
      } else if (status.status === 'boughtOut') {
        const actorEmail = await resolveActorEmailFn(status.completedById)
        const results = await handleBoughtOutFn(contract, documentType, actorEmail, dryRun, handlerDeps)
        summary.boughtOut.push(...results)
        if (results.length === 0) summary.skipped.push({ userId, reason: 'already-boughtOut-nothing-to-invoice' })
      } else {
        logger('info', [logPrefix, `Pureservice user ${userId} has status '${status.status}', nothing to do`])
        summary.skipped.push({ userId, reason: status.status })
      }
    } catch (error) {
      logger('error', [logPrefix, `Error processing Pureservice user ${userId}`, error])
      summary.errors.push({ userId, error: error.message })
    }
  }

  logger('info', [logPrefix, `Done - released: ${summary.released.length}, returned: ${summary.returned.length}, boughtOut: ${summary.boughtOut.length}, skipped: ${summary.skipped.length}, errors: ${summary.errors.length}`])
  return summary
}

module.exports = {
  syncPureserviceAssetLifecycle,
  resolveActorEmail,
  handleReleased,
  handleReturned,
  handleBoughtOut,
  DEFAULT_LOOKBACK_DAYS
}
