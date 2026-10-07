const { schoolInfoList } = require('../datasources/tfk-schools')

const DIGITAL = 'Digitale tjenester'

// Names a school can go by in Graph: officeLocation and primaryLocation from tfk-schools.js
const SCHOOL_NAMES = schoolInfoList.flatMap(s => [s.officeLocation, s.primaryLocation]).map(n => n.toLowerCase())

/**
 * True if the value names a school. Nome's departments ("Nome videregående skole avd Søve") count
 * as Nome, same rule as getSearchScope in the frontend.
 *
 * @param {string} value - companyName or department from Graph
 * @returns {boolean}
 */
const isSchool = (value) => {
  const name = value?.trim().toLowerCase()
  if (!name) return false
  return SCHOOL_NAMES.includes(name) || name.startsWith('nome videregående skole')
}

/**
 * Checks that a user gets any use of the role a group gives.
 * A school role on someone outside a school shows them no elever at all.
 *
 * @param {Object} user - Graph user with companyName and department
 * @param {Object} group - entry from access-groups.js
 * @returns {{ ok: boolean, reason?: string, message?: string }}
 */
const checkAccessRequirement = (user, group) => {
  if (group?.requirement === 'school' && !isSchool(user?.companyName) && !isSchool(user?.department)) {
    return { ok: false, reason: 'not-at-school', message: 'Jobber ikke på en skole og vil ikke se noen elever med denne rollen.' }
  }
  if (group?.requirement === 'digital' && user?.companyName?.trim() !== DIGITAL) {
    return { ok: false, reason: 'not-digital', message: `Tilhører ikke ${DIGITAL}.` }
  }
  return { ok: true }
}

module.exports = {
  isSchool,
  checkAccessRequirement
}
