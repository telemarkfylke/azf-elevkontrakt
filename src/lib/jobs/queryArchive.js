const axios = require('axios').default
const { archive } = require('../../../config')
const getAccessToken = require('../auth/get-endtraid-token')
const { logger } = require('@vtfk/logger')
const { schoolInfoList } = require('../datasources/tfk-schools')
const { sanitizeErrorForLogging, maskFnr } = require('../helpers/maskFnr')

/**
 * The archive answers "unknown ssn" with an HTTP **500** (azf-archive-v2 lib/freg.js throws a plain
 * Error, not an HTTPError). Status alone therefore cannot separate it from a genuinely broken
 * archive, which also returns 500 for P360 failures, the internal null-value guard, and failed
 * administrator e-mails. Hence the narrow message match - brittle by nature, so kept in one place.
 */
const NOT_FOUND_IN_ARCHIVE_PATTERN = /could not find anyone with that ssn/i

/**
 * @param {Error} error
 * @returns {Boolean} - true only for the archive's "this ssn is unknown" response
 */
const isPersonNotFoundError = (error) => {
  const body = error?.response?.data
  const message = typeof body === 'string' ? body : (typeof body?.message === 'string' ? body.message : '')
  return NOT_FOUND_IN_ARCHIVE_PATTERN.test(message)
}

/**
 * The archive answered, but with something the caller must act on rather than retry. `reason` lets
 * the HTTP layer address the right audience: 'not-found' means the admin checks the number,
 * 'no-case-number' means an archive administrator must fix the elevmappe. A plain Error means the
 * archive could not be reached - retry.
 */
class ArchiveLookupError extends Error {
  constructor (reason, message) {
    super(message)
    this.name = 'ArchiveLookupError'
    this.reason = reason
  }
}

/**
 * Shared transport for the Sync* endpoints, and the injection seam the tests use.
 *
 * @param {String} endpoint - e.g. 'SyncElevmappe'
 * @param {Object} body
 * @returns {Promise<Object>}
 */
const callArchive = async (endpoint, body) => {
  const accessToken = await getAccessToken(archive.scope)
  const { data } = await axios.post(`${archive.url}/${endpoint}`, body, { headers: { Authorization: `Bearer ${accessToken}` } })
  return data?.data || data
}

/**
 * Syncs (and creates if needed) a private person in the archive from FREG.
 *
 * @param {String} ssn
 * @param {Boolean} [forceUpdate=true] - false returns an existing archive record untouched
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { privatePerson }
 */
const syncPrivatePerson = async (ssn, forceUpdate = true, deps = {}) => {
  const { callArchive: _callArchive = callArchive } = deps
  try {
    return await _callArchive('SyncPrivatePerson', { ssn, forceUpdate })
  } catch (error) {
    if (isPersonNotFoundError(error)) {
      logger('warn', ['syncPrivatePerson', `Fant ikke person i arkivet: ${maskFnr(ssn)}`])
      throw new ArchiveLookupError('not-found', 'Fant ikke personen i Folkeregisteret eller arkivet')
    }
    logger('error', ['syncPrivatePerson', sanitizeErrorForLogging(error)])
    throw new Error('Kunne ikke nå arkivet')
  }
}

/**
 * Syncs a person and their elevmappe.
 *
 * forceUpdate means "re-read and update an existing person", NOT "never call FREG" - an ssn the
 * archive has never seen falls through to FREG either way, which is what gives us the not-found
 * signal. true updates from FREG (fatal for a fiktiv fnr); false returns an existing record
 * untouched, which is the fiktiv read path.
 *
 * @param {String} ssn
 * @param {Boolean} [forceUpdate=true]
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { privatePerson, elevmappe }
 */
const syncElevMappe = async (ssn, forceUpdate = true, deps = {}) => {
  const { callArchive: _callArchive = callArchive } = deps
  try {
    return await _callArchive('SyncElevmappe', { ssn, forceUpdate })
  } catch (error) {
    if (isPersonNotFoundError(error)) {
      logger('warn', ['syncElevMappe', `Fant ikke person i arkivet: ${maskFnr(ssn)}`])
      throw new ArchiveLookupError('not-found', 'Fant ikke personen i Folkeregisteret eller arkivet')
    }
    logger('error', ['syncElevMappe', sanitizeErrorForLogging(error)])
    throw new Error('Kunne ikke nå arkivet')
  }
}

/**
 * The whole fiktiv-fnr mechanism: a fiktivt fødselsnummer is legitimate exactly when P360 already
 * holds the person, so a mistyped number is in neither FREG nor the archive and gets rejected.
 * Validates and returns the authoritative name/address in one call.
 *
 * @param {String} ssn
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { privatePerson, elevmappe }
 * @throws {ArchiveLookupError} - reason 'not-found' when the archive does not know the ssn
 */
const readElevMappe = async (ssn, deps = {}) => syncElevMappe(ssn, false, deps)

/**
 * Syncs an organisation into the archive so it can be a document contact. The TFK schools are
 * long-established in P360, which is why archiveDocument references their orgNr directly; an
 * arbitrary company from BRREG is not, so it has to be synced first.
 *
 * Rewrites on every call (sync-enterprise.js forces needsChange = true), so call it once per
 * contract - the nightly Xledger job uses queryBrreg instead.
 *
 * Unlike the person endpoints the status IS meaningful here, since getBrregData throws an HTTPError
 * carrying BRREG's own: 404 no such org, 400 malformed orgnr, 500 the archive itself failed.
 *
 * @param {String} orgnr
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { repackedEnterprise, enterprise }
 * @throws {ArchiveLookupError} - reason 'not-found' when BRREG does not know the orgnr
 */
const syncEnterprise = async (orgnr, deps = {}) => {
  const { callArchive: _callArchive = callArchive } = deps
  try {
    return await _callArchive('SyncEnterprise', { orgnr })
  } catch (error) {
    const status = error?.response?.status
    if (status === 404 || status === 400) {
      logger('warn', ['syncEnterprise', `Fant ikke organisasjon i Enhetsregisteret: ${orgnr}`])
      throw new ArchiveLookupError('not-found', 'Fant ikke organisasjonsnummeret i Enhetsregisteret')
    }
    logger('error', ['syncEnterprise', sanitizeErrorForLogging(error)])
    throw new Error('Kunne ikke nå arkivet')
  }
}

/**
 * sync-elevmappe.js does not always return a CaseNumber: its *update* branch returns whatever
 * UpdateCase gave back, and repackSifResult unwraps a single-property result to a bare recno. That
 * branch is taken whenever forceUpdate is true.
 *
 * A missing saksnummer is a manual P360 job for an archive administrator - not fixable here, not
 * fixable by retrying - so stop with a message aimed at them rather than a TypeError.
 *
 * @param {Object} elevmappeResponse - the { privatePerson, elevmappe } body
 * @param {String} ssn - for the log line only, masked
 * @returns {String} - CaseNumber
 * @throws {ArchiveLookupError} - reason 'no-case-number'
 */
const getCaseNumber = (elevmappeResponse, ssn) => {
  const caseNumber = elevmappeResponse?.elevmappe?.CaseNumber
  if (!caseNumber) {
    logger('error', ['getCaseNumber', `Elevmappe uten CaseNumber for ${maskFnr(ssn)}`, JSON.stringify(elevmappeResponse?.elevmappe)])
    throw new ArchiveLookupError('no-case-number', 'Elevmappen mangler saksnummer og må rettes i arkivet av en arkivansvarlig')
  }
  return caseNumber
}

/**
 * Resolves the school from tfk-schools.js. Compared as strings: orgNr is a Number there but arrives
 * as a String, and the previous strict === only worked because callers passed values that had
 * already been through this same list.
 *
 * @param {String|Number} schoolOrgNumber
 * @returns {Object} - the school entry
 */
const findSchool = (schoolOrgNumber) => {
  const wanted = (schoolOrgNumber ?? '').toString().trim()
  const school = schoolInfoList.find(school => school.orgNr.toString() === wanted)
  if (!school) {
    throw new ArchiveLookupError('unknown-school', `Ukjent skoleorganisasjonsnummer: ${wanted || '(tomt)'}`)
  }
  return school
}

/**
 * Archives a signed contract document in P360. Each party needs a different pre-sync:
 *
 *  - elev, ordinary fnr : SyncElevmappe, forceUpdate true
 *  - elev, fiktiv fnr   : SyncElevmappe read-only - FREG has nothing, P360 is the source of truth
 *  - ansvarlig, org     : SyncEnterprise, never SyncPrivatePerson
 *  - ansvarlig, person  : SyncPrivatePerson - always a real FREG person, since a fiktivt fnr cannot
 *                         be invoiced and so can never be the ansvarlig
 *
 * @param {Object} payload
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { Recno, DocumentNumber, ImportedDocumentNumber, UID, UIDOrigin }
 */
const archiveDocument = async (payload, deps = {}) => {
  const {
    syncElevMappe: _syncElevMappe = syncElevMappe,
    syncPrivatePerson: _syncPrivatePerson = syncPrivatePerson,
    syncEnterprise: _syncEnterprise = syncEnterprise,
    postDocument: _postDocument = null
  } = deps

  const logPrefix = 'archiveDocument'
  const isFiktivElev = payload?.elevFnrType === 'fiktiv'
  const isOrgAnsvarlig = payload?.ansvarligType === 'organisasjon'

  const school = findSchool(payload.schoolOrgNumber)

  // For a fiktiv elev this read is also the validation: if P360 does not know them, it throws
  // 'not-found' and no contract is created.
  const elevmappe = await _syncElevMappe(payload.fnr, !isFiktivElev)
  const caseNumber = getCaseNumber(elevmappe, payload.fnr)
  const elevReferenceNumber = elevmappe?.privatePerson?.ssn || payload.fnr

  // Whoever signs the agreement: an organisation, a guardian, or the student themselves.
  let avsenderReferenceNumber
  if (isOrgAnsvarlig) {
    // foresattFnr is the identifier slot for BOTH kinds of ansvarlig - an orgnr here, an fnr on the
    // branch below - and is what documentSchema and postManualContract read. There used to be an
    // `|| payload.ansvarligOrgnr` fallback here that nothing produced; it only meant a payload using
    // that name archived fine and then stored ansvarligInfo.fnr = 'Ukjent', leaving a contract that
    // no invoice run can resolve a recipient for. Better to fail here.
    const orgnr = payload.foresattFnr
    logger('info', [logPrefix, `Ansvarlig er en organisasjon, synkroniserer virksomhet ${orgnr}`])
    const enterprise = await _syncEnterprise(orgnr)
    avsenderReferenceNumber = enterprise?.enterprise?.EnterpriseNumber || orgnr
  } else {
    const ansvarligFnr = payload?.foresattFnr || payload.fnr
    const privatePerson = await _syncPrivatePerson(ansvarligFnr)
    avsenderReferenceNumber = privatePerson?.privatePerson?.ssn || ansvarligFnr
  }

  const payloadToArchive = {
    service: 'DocumentService',
    method: 'CreateDocument',
    parameter: {
      title: payload.title,
      AccessCode: '13',
      AccessGroup: school.tilgangsgruppe,
      Category: 'Dokument inn',
      Contacts: [ // Avsender er alltid den som signerer; mottaker er skolen
        {
          ReferenceNumber: elevReferenceNumber, // FNR til elev
          Role: 'Kopi til',
          IsUnofficial: true
        },
        {
          ReferenceNumber: school.orgNr, // Skolens organisasjonsnummer
          Role: 'Mottaker',
          IsUnofficial: true
        },
        {
          ReferenceNumber: avsenderReferenceNumber, // FNR eller orgnr til den som signerer avtalen
          Role: 'Avsender',
          IsUnofficial: true
        }
      ],
      DocumentDate: new Date().toISOString(),
      Files: [
        {
          Base64Data: payload.attachment,
          Category: '1',
          Format: 'pdf',
          Status: 'F',
          Title: 'Elevavtale - Signert',
          VersionFormat: 'A'
        }
      ],
      Paragraph: 'Offl. § 13 jf. fvl. § 13 (1) nr.1',
      ResponsibleEnterpriseNumber: payload.schoolOrgNumber, // Skolens organisasjonsnummer
      Status: 'J',
      Title: 'Elevavtale - Signert',
      Archive: 'Elevdokument',
      CaseNumber: caseNumber // Elevens mappe i arkivet
    }
  }

  if (_postDocument) return _postDocument(payloadToArchive)

  const accessToken = await getAccessToken(archive.scope)
  let data
  try {
    data = await axios.post(`${archive.url}/archive`, payloadToArchive, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (error) {
    logger('error', ['archive', sanitizeErrorForLogging(error)])
    throw new Error('Internal server error')
  }
  return data.data
}

module.exports = {
  archiveDocument,
  syncElevMappe,
  syncPrivatePerson,
  syncEnterprise,
  readElevMappe,
  getCaseNumber,
  findSchool,
  isPersonNotFoundError,
  ArchiveLookupError
}
