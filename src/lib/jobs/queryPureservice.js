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
    throw err
  }
}

const fetchAllPages = async (baseUrl) => {
  const allUsers = []
  const allEmails = []
  let cursor = 0

  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${sep}limit=${PAGE_SIZE}&start=${cursor}&sort=id`
    const page = await doPureserviceRequest(url)

    const users = page.users ?? []
    if (users.length === 0) break

    allUsers.push(...users)
    if (page.linked?.emailaddresses) {
      allEmails.push(...page.linked.emailaddresses)
    }

    cursor += PAGE_SIZE
  }

  return { users: allUsers, emails: allEmails }
}

/**
 * Fetches all Pureservice users with title "Elev" (students).
 * Returns an array of { pusId, emails[] } objects.
 */
const getAllStudents = async () => {
  const logPrefix = 'queryPureservice - getAllStudents'
  logger('info', [logPrefix, 'Fetching all Pureservice students (Elev)'])

  const filter = encodeURIComponent('title == "Elev"')
  const baseUrl = `${pureservice.url}/agent/api/user/?include=emailaddresses&filter=${filter}`

  const { users, emails } = await fetchAllPages(baseUrl)

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

module.exports = { getAllStudents, patchUser }
