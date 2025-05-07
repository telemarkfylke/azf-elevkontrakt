const { decodeToken } = require('./decodeToken')

/**
 *
 * @param {Array} token Token from the request
 * @param {Array} role Roles needed to access the route
 * @returns {boolean} True if the user has the required role, false otherwise
 */
const validateRoles = (token, role) => {
    if (!role) {
      return false
    }
    if (!token) {
      return false
    }
    token = token.split(' ')[1]
    const toLowerCase = (arr) => arr.map((r) => r.toLowerCase())
    // Convert the roles to lowercase
    const tokenRoles = decodeToken(token, ['roles'])
    const tokenRolesLower = toLowerCase(tokenRoles.roles)

    role = toLowerCase(role)
    // Check if the user has the required role.
    const hasRole = tokenRolesLower.some((r) => role.includes(r))
    return hasRole
}

module.exports = {
  validateRoles
}