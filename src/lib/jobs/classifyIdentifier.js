const { logger } = require('@vtfk/logger')
const { student } = require('./queryFINT')
const { person } = require('./queryFREG')
const { lookupEnhet } = require('./queryBrreg')
const { readElevMappe, ArchiveLookupError } = require('./queryArchive')
const { detectIdentifierType, isValidOrgnrChecksum, normalizeIdentifier } = require('../helpers/identifier')
const { maskFnr } = require('../helpers/maskFnr')
const { isElevforholdActive } = require('../helpers/isElevforholdActive')
const { schoolInfoList } = require('../datasources/tfk-schools')

/**
 * Works out what an identifier the admin typed actually is, so the contract form knows which flow
 * to offer.
 *
 * Easy to get wrong: **FREG is the discriminator, not FINT.** A fiktiv student is enrolled in FINT
 * like anyone else; what they lack is a folkeregister record.
 *
 *   1. FINT student()  -> school and elevforhold. Hits for ordinary AND fiktiv students.
 *   2. FREG person()   -> hit means ordinær, miss means fiktiv candidate.
 *   3. archive, only on a FREG miss -> must confirm the person exists in P360.
 *
 * FREG miss + P360 miss is an error even when FINT hit: a FINT record proves someone enrolled that
 * number, not that it identifies a real person. That is what stops a typo becoming a fake student.
 */

/**
 * Pulls the school out of a FINT student record the same way the contract form does, so a fiktiv
 * student only gets asked for a school when FINT genuinely has nothing to say.
 *
 * @param {Object} studentData
 * @returns {Object|null} - { navn, orgNr } or null
 */
const resolveSchoolFromFint = (studentData) => {
  const elevforhold = Array.isArray(studentData?.elevforhold) ? studentData.elevforhold.filter(forhold => isElevforholdActive(forhold)) : []
  if (elevforhold.length === 0) return null

  // Same preference as validateStudent: skip privatist and the 70036 "school" when there is a choice.
  const primary = elevforhold.find(forhold => forhold.kategori?.navn?.toLowerCase() !== 'privatist' && forhold.skole?.skolenummer !== '70036') || elevforhold[0]
  const navn = primary?.skole?.navn || primary?.basisgruppemedlemskap?.[0]?.skole?.navn
  if (!navn) return null

  const school = schoolInfoList.find(school => school.officeLocation === navn || school.primaryLocation === navn)
  return { navn, orgNr: school ? school.orgNr.toString() : null }
}

/**
 * @param {String} rawIdentifier - whatever the admin typed
 * @param {Object} [deps]
 * @returns {Promise<Object>} - a classification, or { error, reason } when it cannot be used
 */
const classifyIdentifier = async (rawIdentifier, deps = {}) => {
  const {
    student: _student = student,
    person: _person = person,
    lookupEnhet: _lookupEnhet = lookupEnhet,
    readElevMappe: _readElevMappe = readElevMappe
  } = deps

  const logPrefix = 'classifyIdentifier'
  const identifier = normalizeIdentifier(rawIdentifier)
  const type = detectIdentifierType(identifier)

  if (type === null) {
    return { ok: false, reason: 'invalid-format', error: 'Identifikatoren må være enten 11 siffer (fødselsnummer) eller 9 siffer (organisasjonsnummer)' }
  }

  // ---- Organisation -------------------------------------------------------
  if (type === 'orgnr') {
    if (!isValidOrgnrChecksum(identifier)) {
      return { ok: false, reason: 'invalid-format', error: 'Ugyldig organisasjonsnummer (feil kontrollsiffer)' }
    }
    let enhet
    try {
      enhet = await _lookupEnhet(identifier)
    } catch (error) {
      return { ok: false, reason: 'lookup-failed', error: 'Kunne ikke nå Enhetsregisteret. Prøv igjen.' }
    }
    if (!enhet) {
      return { ok: false, reason: 'not-found', error: 'Fant ikke organisasjonsnummeret i Enhetsregisteret' }
    }
    return {
      ok: true,
      type: 'orgnr',
      identifier,
      // An organisation can only ever be the ansvarlig, never the elev.
      canBeElev: false,
      canBeAnsvarlig: !enhet.slettedato,
      organisasjon: enhet
    }
  }

  // ---- Person -------------------------------------------------------------
  // Step 1: FINT. Answers "which school", never "real or fiktiv".
  let studentData = null
  try {
    const fintResult = await _student(identifier)
    if (fintResult && fintResult.status !== 404 && fintResult.message !== 'Not a student') studentData = fintResult
  } catch (error) {
    logger('warn', [logPrefix, 'FINT-oppslag feilet, fortsetter', error.message])
  }

  // Step 2: FREG. THIS is the discriminator.
  let personData = null
  try {
    const fregResult = await _person(identifier)
    if (fregResult?.foedselsEllerDNummer) personData = fregResult
  } catch (error) {
    logger('warn', [logPrefix, 'FREG-oppslag feilet, fortsetter', error.message])
  }

  const school = resolveSchoolFromFint(studentData)

  if (personData) {
    return {
      ok: true,
      type: 'fnr',
      identifier,
      fnrType: 'ordinær',
      source: 'freg',
      canBeElev: true,
      canBeAnsvarlig: true,
      isStudent: Boolean(studentData),
      navn: personData.fulltnavn || studentData?.navn || null,
      school,
      elevforhold: studentData?.elevforhold || null
    }
  }

  // Step 3: not in FREG, so this is a fiktiv candidate. P360 has to confirm it.
  let arkiv
  try {
    arkiv = await _readElevMappe(identifier)
  } catch (error) {
    if (error instanceof ArchiveLookupError && error.reason === 'not-found') {
      logger('info', [logPrefix, `Ukjent identifikator ${maskFnr(identifier)} - verken FREG eller arkivet kjenner den`])
      return {
        ok: false,
        reason: 'not-found',
        // A FINT hit here means someone really did enrol this number - worth saying, so the admin
        // chases the right thing rather than assuming a typo.
        error: studentData
          ? 'Nummeret finnes i skoleadministrativt system, men verken i Folkeregisteret eller i arkivet. Kontroller nummeret.'
          : 'Fant ikke personen i Folkeregisteret eller arkivet. Kontroller nummeret.'
      }
    }
    if (error instanceof ArchiveLookupError && error.reason === 'no-case-number') {
      return { ok: false, reason: 'no-case-number', error: error.message }
    }
    // Anything else means the archive could not be reached. Must NOT read as a bad number.
    logger('error', [logPrefix, 'Arkivoppslag feilet', error.message])
    return { ok: false, reason: 'lookup-failed', error: 'Arkivet kunne ikke nås. Prøv igjen.' }
  }

  logger('info', [logPrefix, `Bekreftet fiktivt fødselsnummer ${maskFnr(identifier)} i arkivet`])
  return {
    ok: true,
    type: 'fnr',
    identifier,
    fnrType: 'fiktiv',
    source: 'arkiv',
    canBeElev: true,
    // A fiktivt fnr cannot become an Xledger customer, so it can never be the invoice recipient.
    canBeAnsvarlig: false,
    isStudent: Boolean(studentData),
    navn: arkiv?.privatePerson?.name || null,
    adresse: {
      gateadresse: arkiv?.privatePerson?.streetAddress || null,
      postnummer: arkiv?.privatePerson?.zipCode || null,
      poststed: arkiv?.privatePerson?.zipPlace || null
    },
    school,
    elevforhold: studentData?.elevforhold || null
  }
}

module.exports = {
  classifyIdentifier,
  resolveSchoolFromFint
}
