const axios = require('axios').default
const NodeCache = require('node-cache')
const { logger } = require('@vtfk/logger')
const { brreg } = require('../../../config')

/**
 * Read-only lookups against Enhetsregisteret.
 *
 * Kept separate from the archive's /SyncEnterprise, which also queries BRREG but *persists* an
 * enterprise in P360 on every call. That one belongs at archive time, once per contract; this one
 * backs interactive validation and the nightly xledgerUserImport without writing anything. It also
 * returns konkurs/underAvvikling/slettedato/epost/telefon, which SyncEnterprise does not.
 *
 * No authentication - the register is open.
 */

const cache = new NodeCache({ stdTTL: 60 * 60 * 24 })

/**
 * @param {Object} address - forretningsadresse or postadresse from BRREG
 * @returns {Object} - { gateadresse, postnummer, poststed, land }, nulls rather than undefined
 */
const repackAddress = (address) => {
  if (!address) return { gateadresse: null, postnummer: null, poststed: null, land: null }
  const lines = Array.isArray(address.adresse) ? address.adresse.filter(Boolean) : []
  return {
    gateadresse: lines.length > 0 ? lines.join(', ') : null,
    postnummer: address.postnummer || null,
    poststed: address.poststed || null,
    land: address.land || null
  }
}

/**
 * Address precedence is postadresse first - deliberately the opposite of the archive's own
 * repackBrreg, which prefers forretningsadresse for a P360 contact record. This address ends up on an
 * invoice, and a company's postadresse is the one it actually collects post at. Do not "fix" this.
 *
 * @param {Object} enhet - raw BRREG response body
 * @param {String} kilde - 'enhet' | 'underenhet'
 * @returns {Object}
 */
const repackEnhet = (enhet, kilde) => {
  const postadresse = repackAddress(enhet.postadresse)
  const forretningsadresse = repackAddress(enhet.forretningsadresse || enhet.beliggenhetsadresse)
  return {
    orgnr: enhet.organisasjonsnummer,
    navn: enhet.navn || null,
    kilde,
    organisasjonsform: enhet.organisasjonsform?.kode || null,
    adresse: postadresse.gateadresse ? postadresse : forretningsadresse,
    postadresse,
    forretningsadresse,
    epostadresse: enhet.epostadresse || null,
    telefon: enhet.telefon || enhet.mobil || null,
    konkurs: enhet.konkurs === true,
    underAvvikling: enhet.underAvvikling === true,
    underTvangsavviklingEllerTvangsopplosning: enhet.underTvangsavviklingEllerTvangsopplosning === true,
    slettedato: enhet.slettedato || null
  }
}

/**
 * @param {String} url
 * @returns {Promise<Object|null>} - null for "no such unit", throws for anything else
 */
const fetchUnit = async (url) => {
  try {
    const { data } = await axios.get(url, { timeout: brreg.timeout })
    return data
  } catch (error) {
    const status = error?.response?.status
    // 410 Gone means removed for legal reasons; the docs say to drop any local copy, so treat as absent.
    // Everything else is a real failure and must not read as "this org number does not exist".
    if (status === 404 || status === 410) return null
    throw error
  }
}

/**
 * Looks up an orgnr, falling back to Underenhetsregisteret. Order mirrors the archive's own
 * getBrregData so the two can never disagree about whether an orgnr resolves.
 *
 * @param {String} orgnr - 9 digits, already mod-11 checked by the caller
 * @returns {Promise<Object|null>} - null if it exists in neither register
 * @throws {Error} - if BRREG could not be reached
 */
const lookupEnhet = async (orgnr) => {
  const logPrefix = 'lookupEnhet'
  const cached = cache.get(orgnr)
  if (cached !== undefined) return cached

  let result = null
  try {
    const enhet = await fetchUnit(`${brreg.url}/enheter/${orgnr}`)
    if (enhet) {
      result = repackEnhet(enhet, 'enhet')
    } else {
      const underenhet = await fetchUnit(`${brreg.url}/underenheter/${orgnr}`)
      result = underenhet ? repackEnhet(underenhet, 'underenhet') : null
    }
  } catch (error) {
    logger('error', [logPrefix, `Klarte ikke å hente data fra BRREG for orgnr ${orgnr}`, error.message])
    throw new Error(`Kunne ikke nå Enhetsregisteret: ${error.message}`)
  }

  cache.set(orgnr, result)
  logger('info', [logPrefix, result ? `Fant ${result.kilde} ${orgnr}` : `Fant ikke orgnr ${orgnr}`])
  return result
}

/** @param {String} [orgnr] - omit to clear every entry */
const clearCache = (orgnr) => {
  if (orgnr) cache.del(orgnr)
  else cache.flushAll()
}

module.exports = {
  lookupEnhet,
  repackEnhet,
  repackAddress,
  clearCache
}
