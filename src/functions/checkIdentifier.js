const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { classifyIdentifier } = require('../lib/jobs/classifyIdentifier.js')

/**
 * Classifies an identifier the admin typed: ordinary fnr, fiktivt fnr, or organisasjonsnummer.
 *
 * Separate from /checkStudent because that one serves the public Acos form and cannot answer this
 * without restructuring - a fiktiv student passes its FINT branch but then hits an age check reading
 * absent FREG data, and KRR calls below that. Not worth a regression visible to students.
 *
 * The status codes are what the frontend branches on, and must stay distinguishable - conflating
 * them is how an archive outage tells an admin their valid fnr is wrong:
 *
 *   200 usable  ·  400 malformed  ·  404 unknown everywhere (admin checks the number)
 *   409 found but elevmappe has no saksnummer (an ARCHIVE ADMINISTRATOR must fix it)
 *   502 a lookup was unreachable - retry
 */
app.http('checkIdentifier', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'checkIdentifier/{identifier}',
  handler: async (request, context) => {
    const logPrefix = 'checkIdentifier'
    const authorizationHeader = request.headers.get('authorization')

    if (!validateRoles(authorizationHeader, ['elevkontrakt.itservicedesk-readwrite', 'elevkontrakt.administrator-readwrite', 'elevkontrakt.skoleadministrator-write'])) {
      logger('error', [logPrefix, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    let result
    try {
      result = await classifyIdentifier(request.params.identifier)
    } catch (error) {
      logger('error', [logPrefix, 'Uventet feil under klassifisering', error.message])
      return { status: 502, jsonBody: { error: 'Oppslaget feilet. Prøv igjen.', reason: 'lookup-failed' } }
    }

    if (result.ok) return { status: 200, jsonBody: result }

    const statusByReason = {
      'invalid-format': 400,
      'not-found': 404,
      'no-case-number': 409,
      'lookup-failed': 502
    }
    return { status: statusByReason[result.reason] || 400, jsonBody: result }
  }
})
