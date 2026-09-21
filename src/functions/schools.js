const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { schoolInfoList } = require('../lib/datasources/tfk-schools.js')

/**
 * School list for the admin UI's picker, needed when a student has no active elevforhold in FINT to
 * derive it from. Served from tfk-schools.js rather than duplicated in the frontend: archiveDocument
 * resolves tilgangsgruppe from this same list, so a copy that drifted would break contract creation.
 *
 * Returns only navn + orgNr; tilgangsgruppe and the Xledger fields are internal.
 */
app.http('schools', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'schools',
  handler: async (request, context) => {
    const logPrefix = 'schools'
    const authorizationHeader = request.headers.get('authorization')

    if (!validateRoles(authorizationHeader, ['elevkontrakt.read', 'elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.administrator-readwrite', 'elevkontrakt.skoleadministrator-write'])) {
      logger('error', [logPrefix, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    // orgNr is a number in tfk-schools.js but a string everywhere it is used (document.skoleOrgNr,
    // payload.schoolOrgNumber). Stringify here so the frontend never has to think about it.
    const schools = schoolInfoList
      .map(school => ({ navn: school.officeLocation, orgNr: school.orgNr.toString() }))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'nb'))

    return { status: 200, jsonBody: schools }
  }
})
