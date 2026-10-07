const axios = require('axios').default
const getMsalToken = require('../auth/get-endtraid-token.js')
// Calls the MSgraph API and returns the data
/**
 *
 * @param {string} url
 * @param {string} method
 * @param {object} data
 * @param {string} consistencyLevel
 * @returns {Promise<any>}
 */
const graphRequest = async (url, method, data, consistencyLevel) => {
  // Get access token
  const accessToken = await getMsalToken('https://graph.microsoft.com/.default')
  // Build the request with data from the call
  const options = {
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  }
  // Add data to the request if it exists
  if (data) options.data = data
  // Add consistency level to the request if it exists
  if (consistencyLevel) options.headers.ConsistencyLevel = 'eventual'
  // Make the request
  const response = await axios(options)
  // Return the data
  return response.data
}

/**
 * Fetches user details from Microsoft Graph API based on the provided user principal name (UPN).
 *
 * @param {string} upn - The user principal name of the user to fetch.
 * @returns {Promise<Object>} A promise that resolves to the user details object.
 * @throws {Error} Throws an error if the 'upn' parameter is not specified.
 */
const getUser = async (upn) => {
  // Input validation
  if (!upn) throw new Error('Cannot search for a user if \'upn\' is not specified')

  const url = `https://graph.microsoft.com/v1.0/users/${upn}?$select=id,displayName,givenName,surname,userPrincipalName,companyName,officeLocation,preferredLanguage,mail,jobTitle,mobilePhone,businessPhones`
  const data = await graphRequest(url, 'GET', 'null')
  return data
}

const GRAPH = 'https://graph.microsoft.com/v1.0'
const EMPLOYEE_SELECT = 'id,displayName,givenName,surname,userPrincipalName,companyName,department,officeLocation,jobTitle'

/**
 * Builds the user search url. Matches first name, last name, full name and UPN,
 * active employee accounts only.
 *
 * @param {string} query
 * @param {string} upnSuffix - e.g. '@telemarkfylke.no'
 * @returns {string}
 */
const buildUserSearchUrl = (query, upnSuffix) => {
  // Quotes and backslashes would break the $search clause
  const q = String(query ?? '').replace(/["\\]/g, '').trim()
  const search = ['displayName', 'givenName', 'surname', 'userPrincipalName'].map(f => `"${f}:${q}"`).join(' OR ')
  const filter = `accountEnabled eq true and endswith(userPrincipalName,'${upnSuffix.replace(/'/g, "''")}')`
  return `${GRAPH}/users?$search=${encodeURIComponent(search)}&$filter=${encodeURIComponent(filter)}&$count=true&$top=25&$select=${EMPLOYEE_SELECT}`
}

/**
 * Searches employees by name or UPN.
 *
 * @param {string} query
 * @param {string} upnSuffix
 * @returns {Promise<Object[]>}
 */
const searchUsers = async (query, upnSuffix) => {
  const data = await graphRequest(buildUserSearchUrl(query, upnSuffix), 'GET', null, true)
  return data.value
}

/**
 * @param {string} id - Graph object id
 * @returns {Promise<Object>}
 */
const getUserById = async (id) => {
  return graphRequest(`${GRAPH}/users/${encodeURIComponent(id)}?$select=${EMPLOYEE_SELECT}`, 'GET')
}

/**
 * All user members of a group, following paging.
 *
 * @param {string} groupId
 * @returns {Promise<Object[]>}
 */
const getGroupMembers = async (groupId) => {
  let url = `${GRAPH}/groups/${encodeURIComponent(groupId)}/members/microsoft.graph.user?$select=${EMPLOYEE_SELECT}&$top=999`
  const members = []
  while (url) {
    const data = await graphRequest(url, 'GET')
    members.push(...data.value)
    url = data['@odata.nextLink']
  }
  return members
}

/**
 * @param {string} groupId
 * @param {string} userId
 */
const addGroupMember = async (groupId, userId) => {
  await graphRequest(`${GRAPH}/groups/${encodeURIComponent(groupId)}/members/$ref`, 'POST', { '@odata.id': `${GRAPH}/directoryObjects/${userId}` })
}

/**
 * @param {string} groupId
 * @param {string} userId
 */
const removeGroupMember = async (groupId, userId) => {
  await graphRequest(`${GRAPH}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`, 'DELETE')
}

module.exports = {
  getUser,
  buildUserSearchUrl,
  searchUsers,
  getUserById,
  getGroupMembers,
  addGroupMember,
  removeGroupMember
}
