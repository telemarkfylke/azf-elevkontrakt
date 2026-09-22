'use strict'

const { test, describe, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios').default
const { lookupEnhet, repackEnhet, repackAddress, clearCache } = require('../queryBrreg.js')

// The live Enhetsregisteret record for Telemark fylkeskommune, trimmed to the fields the repacker
// reads. Its postadresse and forretningsadresse genuinely differ, which is what makes it a useful
// fixture for the postadresse-first rule. BRREG holds no e-mail or phone for it.
const TELEMARK = {
  organisasjonsnummer: '929882989',
  navn: 'TELEMARK FYLKESKOMMUNE',
  organisasjonsform: { kode: 'FYLK' },
  epostadresse: null,
  telefon: null,
  konkurs: false,
  underAvvikling: false,
  postadresse: { adresse: ['Postboks 2844'], postnummer: '3702', poststed: 'SKIEN', land: 'Norge' },
  forretningsadresse: { adresse: ['Torggata 18'], postnummer: '3717', poststed: 'SKIEN', land: 'Norge' }
}

const axiosError = (status) => {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status }
  return error
}

describe('repackAddress', () => {
  test('joins the street-line array', () => {
    const address = repackAddress({ adresse: ['Torggata 18', 'Inngang B'], postnummer: '3717', poststed: 'SKIEN' })
    assert.equal(address.gateadresse, 'Torggata 18, Inngang B')
    assert.equal(address.postnummer, '3717')
    assert.equal(address.poststed, 'SKIEN')
  })

  test('drops empty lines rather than emitting stray separators', () => {
    const address = repackAddress({ adresse: ['Torggata 18', '', null], postnummer: '3717' })
    assert.equal(address.gateadresse, 'Torggata 18')
  })

  test('a missing address is all nulls, never undefined', () => {
    assert.deepEqual(repackAddress(undefined), { gateadresse: null, postnummer: null, poststed: null, land: null })
    assert.deepEqual(repackAddress({}), { gateadresse: null, postnummer: null, poststed: null, land: null })
  })
})

describe('repackEnhet', () => {
  test('prefers postadresse over forretningsadresse (this is an invoice address)', () => {
    const enhet = repackEnhet(TELEMARK, 'enhet')
    assert.equal(enhet.adresse.gateadresse, 'Postboks 2844')
    assert.equal(enhet.adresse.postnummer, '3702')
    // Both remain available for anyone who needs the physical address.
    assert.equal(enhet.forretningsadresse.gateadresse, 'Torggata 18')
  })

  test('falls back to forretningsadresse when there is no postadresse', () => {
    const enhet = repackEnhet({ ...TELEMARK, postadresse: undefined }, 'enhet')
    assert.equal(enhet.adresse.gateadresse, 'Torggata 18')
    assert.equal(enhet.adresse.postnummer, '3717')
  })

  test('falls back to beliggenhetsadresse for an underenhet', () => {
    const underenhet = repackEnhet({
      organisasjonsnummer: '123456785',
      navn: 'AVDELING',
      beliggenhetsadresse: { adresse: ['Storgata 1'], postnummer: '3900', poststed: 'PORSGRUNN' }
    }, 'underenhet')
    assert.equal(underenhet.adresse.gateadresse, 'Storgata 1')
    assert.equal(underenhet.kilde, 'underenhet')
  })

  test('carries the status flags the UI warns on', () => {
    const enhet = repackEnhet({ ...TELEMARK, konkurs: true, underAvvikling: true, slettedato: '2025-01-01' }, 'enhet')
    assert.equal(enhet.konkurs, true)
    assert.equal(enhet.underAvvikling, true)
    assert.equal(enhet.slettedato, '2025-01-01')
  })

  test('absent flags are false rather than undefined', () => {
    const enhet = repackEnhet({ organisasjonsnummer: '929882989', navn: 'X' }, 'enhet')
    assert.equal(enhet.konkurs, false)
    assert.equal(enhet.underAvvikling, false)
    assert.equal(enhet.slettedato, null)
    assert.equal(enhet.epostadresse, null)
    assert.equal(enhet.telefon, null)
  })
})

describe('lookupEnhet', () => {
  beforeEach(() => clearCache())
  afterEach(() => mock.restoreAll())

  test('returns the unit from /enheter without touching /underenheter', async () => {
    const get = mock.method(axios, 'get', async () => ({ data: TELEMARK }))
    const result = await lookupEnhet('929882989')

    assert.equal(result.navn, 'TELEMARK FYLKESKOMMUNE')
    assert.equal(result.kilde, 'enhet')
    assert.equal(get.mock.callCount(), 1)
    assert.match(get.mock.calls[0].arguments[0], /\/enheter\/929882989$/)
  })

  test('falls back to /underenheter on a 404 from /enheter', async () => {
    const get = mock.method(axios, 'get', async (url) => {
      if (url.includes('/underenheter/')) return { data: { organisasjonsnummer: '123456785', navn: 'AVDELING' } }
      throw axiosError(404)
    })
    const result = await lookupEnhet('123456785')

    assert.equal(result.navn, 'AVDELING')
    assert.equal(result.kilde, 'underenhet')
    assert.equal(get.mock.callCount(), 2)
  })

  test('returns null when the orgnr is in neither register', async () => {
    mock.method(axios, 'get', async () => { throw axiosError(404) })
    assert.equal(await lookupEnhet('999999999'), null)
  })

  test('treats 410 Gone as absent', async () => {
    mock.method(axios, 'get', async () => { throw axiosError(410) })
    assert.equal(await lookupEnhet('999999999'), null)
  })

  test('THROWS on a server error — a BRREG outage must never read as "no such company"', async () => {
    mock.method(axios, 'get', async () => { throw axiosError(503) })
    await assert.rejects(() => lookupEnhet('929882989'), /Kunne ikke nå Enhetsregisteret/)
  })

  test('THROWS on a network failure rather than returning null', async () => {
    mock.method(axios, 'get', async () => { throw new Error('ETIMEDOUT') })
    await assert.rejects(() => lookupEnhet('929882989'), /Kunne ikke nå Enhetsregisteret/)
  })

  test('a cache hit does not re-request', async () => {
    const get = mock.method(axios, 'get', async () => ({ data: TELEMARK }))

    const first = await lookupEnhet('929882989')
    const second = await lookupEnhet('929882989')

    assert.equal(get.mock.callCount(), 1)
    assert.deepEqual(first, second)
  })

  test('a cached miss is also not re-requested', async () => {
    const get = mock.method(axios, 'get', async () => { throw axiosError(404) })

    assert.equal(await lookupEnhet('999999999'), null)
    assert.equal(await lookupEnhet('999999999'), null)

    // 2 calls for the first lookup (enheter + underenheter), none for the second.
    assert.equal(get.mock.callCount(), 2)
  })

  test('a thrown lookup is not cached, so the next call retries', async () => {
    let attempt = 0
    const get = mock.method(axios, 'get', async () => {
      attempt++
      if (attempt === 1) throw axiosError(503)
      return { data: TELEMARK }
    })

    await assert.rejects(() => lookupEnhet('929882989'))
    const result = await lookupEnhet('929882989')

    assert.equal(result.navn, 'TELEMARK FYLKESKOMMUNE')
    assert.equal(get.mock.callCount(), 2)
  })
})
