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

module.exports = {
  getUser
}
