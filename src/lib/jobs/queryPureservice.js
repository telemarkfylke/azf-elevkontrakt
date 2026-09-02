const axios = require('axios').default
const { logger } = require('@vtfk/logger')
const config = require('../../../config')

const { pureservice } = config

const CALL_DEPTH = 7
const SLEEP_TIME_BASE_MS = 15000
const PAGE_SIZE = 500
const REQUEST_TIMEOUT_MS = 30000

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const doPureserviceRequest = async (url, depth = 1) => {
  const logPrefix = 'queryPureservice'
  try {
    const response = await axios.get(url, {
      headers: {
        Accept: 'application/vnd.api+json',
        'X-Authorization-Key': pureservice.key
      },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (err) {
    if (err.response?.status === 429) {
      if (depth >= CALL_DEPTH) {
        logger('error', [logPrefix, `Rate limited: giving up after ${depth} attempts on ${url}`])
        throw new Error('Too many request attempts to Pureservice')
      }
      const retryAfter = err.response.headers['retry-after']
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : SLEEP_TIME_BASE_MS
      logger('warn', [logPrefix, `Rate limited (depth ${depth}), sleeping ${waitMs / 1000}s before retry`])
      await sleep(waitMs)
      return doPureserviceRequest(url, depth + 1)
    }
    if (err.response) {
      // axios's own err.message ("Request failed with status code 400") hides the actual
      // validation detail Pureservice returns in the response body - surface it here so a bad
      // filter/param shows up in the log instead of a bare status code.
      logger('error', [logPrefix, `Pureservice returned ${err.response.status} for ${url}`, JSON.stringify(err.response.data)])
    }
    throw err
  }
}

/**
 * Pages through a Pureservice list endpoint until an empty page is returned, accumulating the
 * root collection (keyed by rootKey, e.g. 'users' or 'assetregistrations') and all `linked`
 * sub-collections generically (keyed by their own name, e.g. 'emailaddresses', 'assets').
 * @param {string} baseUrl - list endpoint URL, without limit/start/sort params
 * @param {string} rootKey - the response's top-level array key to accumulate
 * @param {string} [sort] - value for the `sort` query param (default 'id', matches prior behavior)
 * @returns {Promise<{items: Array, linked: Object<string, Array>}>}
 */
const fetchAllPages = async (baseUrl, rootKey, sort = 'id') => {
  const items = []
  const linked = {}
  let cursor = 0

  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${sep}limit=${PAGE_SIZE}&start=${cursor}&sort=${encodeURIComponent(sort)}`
    const page = await doPureserviceRequest(url)

    const pageItems = page[rootKey] ?? []
    if (pageItems.length === 0) break

    items.push(...pageItems)
    if (page.linked) {
      for (const [key, value] of Object.entries(page.linked)) {
        if (!linked[key]) linked[key] = []
        linked[key].push(...value)
      }
    }

    cursor += PAGE_SIZE
  }

  return { items, linked }
}

/**
 * Fetches all Pureservice users with title "Elev" or "Elev-" (students).
 * Returns an array of { pusId, emails[] } objects.
 */
const getAllStudents = async () => {
  const logPrefix = 'queryPureservice - getAllStudents'
  logger('info', [logPrefix, 'Fetching all Pureservice students (Elev / Elev-)'])

  const filter = encodeURIComponent('title == "Elev" || title == "Elev-"')
  const baseUrl = `${pureservice.url}/agent/api/user/?include=emailaddresses&filter=${filter}`

  const { items: users, linked } = await fetchAllPages(baseUrl, 'users')
  const emails = linked.emailaddresses ?? []

  // Build userId → emails[] map from the linked emailaddresses
  const emailsByUserId = {}
  for (const emailObj of emails) {
    if (!emailsByUserId[emailObj.userId]) {
      emailsByUserId[emailObj.userId] = []
    }
    emailsByUserId[emailObj.userId].push(emailObj.email)
  }

  const students = users.map(user => ({
    pusId: user.id,
    emails: emailsByUserId[user.id] ?? []
  }))

  logger('info', [logPrefix, `Found ${students.length} Pureservice students`])
  return students
}

/**
 * Updates an existing Pureservice user record.
 * @param {number} pusId - Pureservice user ID
 * @param {object} payload - PusUserInput fields to update (e.g. { department, cf_1 })
 */
const patchUser = async (pusId, payload) => {
  const logPrefix = 'queryPureservice - patchUser'
  const url = `${pureservice.url}/agent/api/user/${pusId}`
  let depth = 1

  while (true) {
    try {
      await axios.patch(url, payload, {
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          'X-Authorization-Key': pureservice.key
        },
        timeout: REQUEST_TIMEOUT_MS
      })
      return
    } catch (err) {
      if (err.response?.status === 429) {
        if (depth >= CALL_DEPTH) {
          logger('error', [logPrefix, `Rate limited: giving up after ${depth} attempts for user ${pusId}`])
          throw new Error('Too many request attempts to Pureservice')
        }
        const retryAfter = err.response.headers['retry-after']
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : SLEEP_TIME_BASE_MS
        logger('warn', [logPrefix, `Rate limited (depth ${depth}), sleeping ${waitMs / 1000}s before retry`])
        await sleep(waitMs)
        depth++
      } else {
        throw err
      }
    }
  }
}

/**
 * Fetches a single Pureservice user record, optionally including a related resource.
 * @param {number|string} pusId - Pureservice user ID
 * @param {string} [includeParam] - value for the `include` query param (e.g. a relation name)
 */
const getUser = async (pusId, includeParam) => {
  const url = `${pureservice.url}/agent/api/user/${pusId}${includeParam ? `?include=${includeParam}` : ''}`
  return doPureserviceRequest(url)
}

/**
 * Fetches a Pureservice user's full AssetRegistration history, most recent first.
 * `status` is not a reliable active/inactive signal (a completed registration can still
 * carry a non-zero status) - use `completed === null` on the returned records instead.
 * @param {number|string} pusId - Pureservice user ID
 */
const getAssetRegistrations = async (pusId) => {
  const filter = encodeURIComponent(`userId == ${pusId}`)
  const include = 'asset,assetRegistrationType,completedReason,completedTicket,assetToUserRelationship'
  const sort = encodeURIComponent('created DESC')
  const url = `${pureservice.url}/agent/api/assetregistration/?filter=${filter}&include=${include}&sort=${sort}`
  return doPureserviceRequest(url)
}

/**
 * Fetches all active Pureservice asset types (e.g. to identify which type(s) mean PC/laptop).
 */
const getAssetTypes = async () => {
  const url = `${pureservice.url}/agent/api/assettype/?limit=${PAGE_SIZE}`
  return doPureserviceRequest(url)
}

/**
 * Fetches all active Pureservice asset registration types.
 */
const getAssetRegistrationTypes = async () => {
  const url = `${pureservice.url}/agent/api/assetregistrationtype/?limit=${PAGE_SIZE}`
  return doPureserviceRequest(url)
}

/**
 * Pages through /agent/api/assetregistration/ to an empty page (like fetchAllPages), then keeps
 * only registrations whose `dateField` value is after `sinceISO` - the date cutoff is applied
 * entirely client-side, with NO early exit based on sort order.
 *
 * That's deliberate, not an oversight: comparing a DateTimeOffset field with `>` 400s no matter
 * how the date value is written, confirmed live against this Pureservice instance -
 *   - quoted (`completed > "2026-08-31T12:00:00Z"`) -> "Operator '>' incompatible with operand
 *     types 'DateTimeOffset?' and 'String'" (quoted value parses as a String literal)
 *   - unquoted (`completed > 2026-08-31T12:00:00Z`) -> "...and 'Int32'" (the `-` in the date
 *     gets parsed as arithmetic subtraction, not as part of a date literal)
 * An earlier version of this function sorted by `${dateField} DESC` and stopped as soon as one
 * out-of-window item was seen, to bound the work without a server-side filter. That assumed
 * `sort=completed DESC` (and, less certainly, `sort=created DESC` on this unfiltered/global
 * endpoint) is honored - unverified, and disproven live: a 200-day lookback still found zero
 * results for a reason known to have real completions in that window, meaning the "sorted"
 * order the early-exit trusted wasn't actually chronological. Do not reintroduce early exit here
 * without first confirming sort=<field> is honored for that exact field on this exact endpoint.
 * @param {string} baseUrl - list endpoint URL (filter/include already applied), no limit/start/sort
 * @param {string} dateField - the field to cut off by (e.g. 'created', 'completed')
 * @param {string} sinceISO
 */
const fetchRecentAssetRegistrationPages = async (baseUrl, dateField, sinceISO) => {
  const { items: allItems, linked } = await fetchAllPages(baseUrl, 'assetregistrations')
  const sinceMs = new Date(sinceISO).getTime()
  const items = allItems.filter(item => item[dateField] && new Date(item[dateField]).getTime() > sinceMs)
  return { items, linked }
}

/**
 * Fetches AssetRegistration records completed with a specific reason after a given time, across
 * ALL users - used to discover recent PC returns/buyouts without polling every student.
 * @param {Object} params
 * @param {number} params.completedReasonId
 * @param {string} params.sinceISO - ISO timestamp; only registrations completed after this are returned
 */
const getCompletedAssetRegistrations = async ({ completedReasonId, sinceISO }) => {
  const filter = encodeURIComponent(`completedReasonId == ${completedReasonId}`)
  const baseUrl = `${pureservice.url}/agent/api/assetregistration/?filter=${filter}&include=asset`
  const { items: assetregistrations, linked } = await fetchRecentAssetRegistrationPages(baseUrl, 'completed', sinceISO)
  return { assetregistrations, linked }
}

/**
 * Fetches AssetRegistration records created after a given time, across ALL users - used to
 * discover recently-issued PCs without polling every student. Includes both active and already-
 * completed registrations; callers should filter on `completed === null` client-side.
 *
 * Unlike getCompletedAssetRegistrations, this has no completedReasonId (or any other) filter, so
 * it fetches every AssetRegistration in the system, of every asset type - potentially a much
 * larger set. Accepted for now (this job already accepts "a large batch just takes longer" as a
 * known tradeoff, see docs/pureservice-asset-lifecycle.md), but worth revisiting if it becomes
 * slow in practice - e.g. by finding a genuinely-confirmed-reliable server-side date filter, or
 * narrowing via `include`/an asset-type filter if the API supports filtering on a linked entity.
 * @param {Object} params
 * @param {string} params.sinceISO
 */
const getRecentlyCreatedAssetRegistrations = async ({ sinceISO }) => {
  const baseUrl = `${pureservice.url}/agent/api/assetregistration/?include=asset`
  const { items: assetregistrations, linked } = await fetchRecentAssetRegistrationPages(baseUrl, 'created', sinceISO)
  return { assetregistrations, linked }
}

module.exports = {
  getAllStudents,
  patchUser,
  getUser,
  getAssetRegistrations,
  getAssetTypes,
  getAssetRegistrationTypes,
  getCompletedAssetRegistrations,
  getRecentlyCreatedAssetRegistrations
}
