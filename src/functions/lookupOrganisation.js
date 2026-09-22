const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { lookupEnhet } = require('../lib/jobs/queryBrreg.js')
const { detectIdentifierType, isValidOrgnrChecksum, normalizeIdentifier } = require('../lib/helpers/identifier.js')

/**
 * Looks up an organisasjonsnummer in Enhetsregisteret so the admin UI can validate it and prefill
 * the ansvarlig fields before a contract is created.
 *
 * Read-only by design - creating the enterprise in P360 happens once, at archive time, via
 * /SyncEnterprise. Driving this endpoint off that one would leave a P360 record behind for every
 * mistyped number an admin ever pastes in.
 */
app.http('lookupOrganisation', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lookupOrganisation/{orgnr}',
  handler: async (request, context) => {
    const logPrefix = 'lookupOrganisation'
    const authorizationHeader = request.headers.get('authorization')

    // Administrator only: an organisasjon can only ever appear on a contract as the ansvarlig, and
    // only an administrator may create such a contract. Nothing else calls this.
    if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
      logger('error', [logPrefix, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    const orgnr = normalizeIdentifier(request.params.orgnr)

    // Shape first, so a typo never becomes a BRREG round trip.
    if (detectIdentifierType(orgnr) !== 'orgnr') {
      return { status: 400, jsonBody: { error: 'Et organisasjonsnummer må bestå av nøyaktig 9 siffer', orgnr } }
    }
    if (!isValidOrgnrChecksum(orgnr)) {
      return { status: 400, jsonBody: { error: 'Ugyldig organisasjonsnummer (feil kontrollsiffer)', orgnr } }
    }

    let enhet
    try {
      enhet = await lookupEnhet(orgnr)
    } catch (error) {
      // lookupEnhet throws only when BRREG was unreachable; a real "no such unit" returns null. Kept
      // apart so the admin is not told to check a number that is fine.
      logger('error', [logPrefix, `Oppslag mot Enhetsregisteret feilet for ${orgnr}`, error.message])
      return { status: 502, jsonBody: { error: 'Kunne ikke nå Enhetsregisteret. Prøv igjen.', orgnr } }
    }

    if (!enhet) {
      logger('info', [logPrefix, `Fant ikke orgnr ${orgnr}`])
      return { status: 404, jsonBody: { error: 'Fant ikke organisasjonsnummeret i Enhetsregisteret', orgnr } }
    }

    if (enhet.slettedato) {
      logger('info', [logPrefix, `Orgnr ${orgnr} er slettet ${enhet.slettedato}`])
      return { status: 410, jsonBody: { error: `Organisasjonen er slettet (${enhet.slettedato}) og kan ikke være ansvarlig`, orgnr, navn: enhet.navn } }
    }

    // konkurs / underAvvikling are returned rather than rejected - the UI warns, the admin decides.
    // A company under avvikling may still owe for a PC already handed out.
    logger('info', [logPrefix, `Fant ${enhet.kilde} ${orgnr}`])
    return { status: 200, jsonBody: enhet }
  }
})
