'use strict'

const { logger } = require('@vtfk/logger')
const { getAssetRegistrations } = require('./queryPureservice.js')

// Confirmed via GET /agent/api/assettype/ - 3 is the "PC" asset type.
const PC_ASSET_TYPE_IDS = [3]

// completedReasonId resolves via include=completedReason to linked.assetregistrationtypeitems[].value.
// Both confirmed directly from live responses:
// 11 = "Innlevering (bruker slutter)" (user 345), 14 = "Privatisering" (user 1589).
// Only these two reason types have been observed so far - others fall through to 'unknown'
// (logged) rather than being silently miscategorized; extend these lists as more are seen.
const RETURNED_REASON_IDS = [11]
const BOUGHT_OUT_REASON_IDS = [14]

/**
 * Decides a Pureservice user's PC possession/disposition from their AssetRegistration
 * history: currently has a PC, never had one, or had one that was returned/bought out.
 * @param {Array<Object>} registrations - assetregistrations records for the user
 * @param {Array<Object>} linkedAssets - linked.assets from the same API response
 * @param {Object} [config]
 * @param {Array<number>} [config.pcAssetTypeIds]
 * @param {Array<number>} [config.returnedReasonIds]
 * @param {Array<number>} [config.boughtOutReasonIds]
 * @returns {Object} - { status: 'never' | 'has' | 'returned' | 'boughtOut' | 'unknown', ... }
 */
const classifyPcPossession = (registrations, linkedAssets, config = {}) => {
  const {
    pcAssetTypeIds = PC_ASSET_TYPE_IDS,
    returnedReasonIds = RETURNED_REASON_IDS,
    boughtOutReasonIds = BOUGHT_OUT_REASON_IDS
  } = config

  const assetsById = new Map(linkedAssets.map(asset => [asset.id, asset]))
  const pcRegistrations = registrations
    .filter(r => pcAssetTypeIds.includes(assetsById.get(r.assetId)?.typeId))
    .sort((a, b) => new Date(b.created) - new Date(a.created))

  if (pcRegistrations.length === 0) return { status: 'never' }

  const active = pcRegistrations.find(r => r.completed === null)
  if (active) {
    const asset = assetsById.get(active.assetId)
    return { status: 'has', assetId: active.assetId, uniqueId: asset?.uniqueId, since: active.created, createdById: active.createdById }
  }

  const [mostRecentlyCompleted] = pcRegistrations
  const { completedReasonId } = mostRecentlyCompleted
  const base = {
    assetId: mostRecentlyCompleted.assetId,
    uniqueId: assetsById.get(mostRecentlyCompleted.assetId)?.uniqueId,
    completed: mostRecentlyCompleted.completed,
    completedReasonId,
    completedById: mostRecentlyCompleted.completedById
  }

  if (returnedReasonIds.includes(completedReasonId)) return { status: 'returned', ...base }
  if (boughtOutReasonIds.includes(completedReasonId)) return { status: 'boughtOut', ...base }

  logger('warn', ['classifyPcPossession', `Unmapped completedReasonId ${completedReasonId} on assetregistration ${mostRecentlyCompleted.id} - update RETURNED_REASON_IDS/BOUGHT_OUT_REASON_IDS`])
  return { status: 'unknown', ...base }
}

/**
 * Fetches a Pureservice user's asset registration history and classifies their PC
 * possession/disposition status.
 * @param {number|string} pusId - Pureservice user ID
 * @param {Object} [deps]
 * @param {Function} [deps.getAssetRegistrationsFn]
 * @param {Object} [deps.config] - passed through to classifyPcPossession; omit to use the module defaults
 */
const getPcPossessionStatus = async (pusId, deps = {}) => {
  const { getAssetRegistrationsFn = getAssetRegistrations, config } = deps
  const { assetregistrations = [], linked = {} } = await getAssetRegistrationsFn(pusId)
  return classifyPcPossession(assetregistrations, linked.assets ?? [], config)
}

module.exports = { classifyPcPossession, getPcPossessionStatus, PC_ASSET_TYPE_IDS }
