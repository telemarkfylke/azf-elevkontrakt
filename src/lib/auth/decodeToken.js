import { jwtDecode } from 'jwt-decode'

/**
 *
 * @param {String} token | Token to decode
 * @param {Array} tokenValues | Token values to decode and return
 * @returns {Object} | Decoded token values
 */

export const decodeToken = (token, tokenValues) => {
  if (!token) {
    return null
  }

  // Basic token values to return if none is provided
  if (!tokenValues) {
    tokenValues = ['upn', 'roles']
  }

  const decoded = jwtDecode(token)

  if (tokenValues) {
    const values = {}
    tokenValues.forEach((value) => {
      values[value] = decoded[value]
    })
    return values
  }

  return decoded
}
