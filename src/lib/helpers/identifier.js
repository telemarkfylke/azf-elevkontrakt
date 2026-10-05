/**
 * Identifier handling for the two kinds of party a contract can carry: a person (11-digit fnr) or an
 * organisation (9-digit orgnr).
 *
 * Both live in `ansvarligInfo.fnr`, because that is the field every Xledger CompanyNo builder already
 * reads. `ansvarligInfo.type` is what guards the lookups, so FREG/KRR are never called for an org.
 */

// Mod-11 weights for an organisasjonsnummer, applied to the 8 leading digits.
const ORGNR_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2]
// Mod-11 weights for the two control digits of a fødselsnummer / D-nummer.
const FNR_K1_WEIGHTS = [3, 7, 6, 1, 8, 9, 4, 5, 2]
const FNR_K2_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]

const FNR_LENGTH = 11
const ORGNR_LENGTH = 9

// Applied by every document builder so no source can emit a contract without the discriminators.
const IDENTIFIER_DEFAULTS = {
  ansvarligType: 'person',
  elevFnrType: 'ordinær'
}

/**
 * @param {String} value
 * @returns {String} - digits only, or '' for anything unusable
 */
const normalizeIdentifier = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return value.toString().replace(/[\s. -]/g, '')
}

/**
 * Person or organisation, by length alone.
 *
 * Deliberately no mod-11 check on the 11-digit path: a fiktivt fødselsnummer frequently fails it, and
 * rejecting those here would block the whole fiktiv-fnr feature. FREG decides real vs fiktiv.
 *
 * @param {String} value
 * @returns {'fnr'|'orgnr'|null}
 */
const detectIdentifierType = (value) => {
  const normalized = normalizeIdentifier(value)
  if (!/^\d+$/.test(normalized)) return null
  if (normalized.length === FNR_LENGTH) return 'fnr'
  if (normalized.length === ORGNR_LENGTH) return 'orgnr'
  return null
}

/**
 * Mod-11 checksum for an organisasjonsnummer. Required, unlike the fnr case - BRREG answers 400 for a
 * bad checksum, so catching it locally saves a round trip.
 *
 * @param {String} value
 * @returns {Boolean}
 */
const isValidOrgnrChecksum = (value) => {
  const normalized = normalizeIdentifier(value)
  if (!/^\d{9}$/.test(normalized)) return false

  const digits = normalized.split('').map(Number)
  const sum = ORGNR_WEIGHTS.reduce((acc, weight, i) => acc + (weight * digits[i]), 0)
  const remainder = sum % 11
  const controlDigit = remainder === 0 ? 0 : 11 - remainder

  if (controlDigit === 10) return false // not expressible in one digit
  return controlDigit === digits[8]
}

const mod11ControlDigit = (digits, weights) => {
  const remainder = weights.reduce((acc, weight, i) => acc + (weight * digits[i]), 0) % 11
  return remainder === 0 ? 0 : 11 - remainder
}

/**
 * Mod-11 checksum for a fødselsnummer or D-nummer. Only for the ansvarlig - a fiktiv elev number
 * often fails it (see detectIdentifierType), but an ansvarlig is never fiktiv.
 *
 * @param {String} value
 * @returns {Boolean}
 */
const isValidFnrChecksum = (value) => {
  const normalized = normalizeIdentifier(value)
  if (!/^\d{11}$/.test(normalized)) return false

  const digits = normalized.split('').map(Number)
  const k1 = mod11ControlDigit(digits, FNR_K1_WEIGHTS)
  if (k1 === 10 || k1 !== digits[9]) return false
  const k2 = mod11ControlDigit(digits, FNR_K2_WEIGHTS)
  return k2 !== 10 && k2 === digits[10]
}

/**
 * Always read the type through this rather than testing `info.type` directly: contracts written
 * before the field existed have no `type`, and invoice `recipient` snapshots never get backfilled.
 *
 * @param {Object} ansvarligInfo
 * @returns {'person'|'organisasjon'}
 */
const getAnsvarligType = (ansvarligInfo) => {
  return ansvarligInfo?.type === 'organisasjon' ? 'organisasjon' : 'person'
}

const isOrganisation = (ansvarligInfo) => getAnsvarligType(ansvarligInfo) === 'organisasjon'

/**
 * Only the elev can be fiktiv - an ansvarlig must be billable, so it is always a real FREG person or
 * an organisation.
 *
 * @param {Object} elevInfo
 * @returns {'ordinær'|'fiktiv'}
 */
const getElevFnrType = (elevInfo) => {
  return elevInfo?.fnrType === 'fiktiv' ? 'fiktiv' : 'ordinær'
}

const isFiktivElev = (elevInfo) => getElevFnrType(elevInfo) === 'fiktiv'

module.exports = {
  IDENTIFIER_DEFAULTS,
  FNR_LENGTH,
  ORGNR_LENGTH,
  normalizeIdentifier,
  detectIdentifierType,
  isValidOrgnrChecksum,
  isValidFnrChecksum,
  getAnsvarligType,
  isOrganisation,
  getElevFnrType,
  isFiktivElev
}
