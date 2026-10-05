'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { resolveSubledgerRecipient, buildSubledgerRow, buildFailureFacts, needsManualReview } = require('../serverJobs/xledgerUserImport.js')
const { retry } = require('../../changeStream/retry.js')

/**
 * Anything that is not fully resolved must come back ok: false, because the caller only exports and
 * marks as imported what resolves. The old code exported FREG's { status, message } error object as
 * a recipient, which produced rows with nothing but CompanyNo.
 */

// Synthetic, checksum-valid numbers.
const FNR = '01019000083'
const D_NUMBER = '41019000077'
const OTHER_FNR = '15058500027'
const ORGNR = '929882989'

const FREG_PERSON = {
  fulltnavn: 'OLA NORDMANN',
  foedselsEllerDNummer: FNR,
  bostedsadresse: { gateadresse: 'STORGATA 1', postnummer: '3900', poststed: 'PORSGRUNN' }
}

const KRR_RESPONSE = { personer: [{ kontaktinformasjon: { epostadresse: 'ola@example.no', mobiltelefonnummer: '+4799999999' } }] }

// Matches the live Enhetsregisteret record: BRREG holds no e-mail or phone for Telemark
// fylkeskommune, which is the common case the admin-entered invoice address exists for.
const BRREG_ENHET = {
  orgnr: ORGNR,
  navn: 'TELEMARK FYLKESKOMMUNE',
  adresse: { gateadresse: 'Postboks 2844', postnummer: '3702', poststed: 'SKIEN' },
  epostadresse: null,
  telefon: null
}

// Each source is either a fixed response or an array of responses, one per call. An Error is thrown.
const respond = (source, n) => {
  const value = Array.isArray(source) ? source[Math.min(n, source.length - 1)] : source
  if (value instanceof Error) throw value
  return value
}

const makeDeps = ({ personData = FREG_PERSON, krrData = KRR_RESPONSE, enhet = BRREG_ENHET } = {}) => {
  const seen = { freg: 0, krr: 0, brreg: 0 }
  return {
    seen,
    deps: {
      getPersonData: async () => respond(personData, seen.freg++),
      getKRRData: async () => respond(krrData, seen.krr++),
      lookupEnhet: async () => respond(enhet, seen.brreg++),
      retry: (fn) => retry(fn, { baseDelayMs: 0 })
    }
  }
}

const personContract = (ansvarligInfo = {}) => ({
  _id: 'doc-1',
  ansvarligInfo: { navn: 'Ola Nordmann', fnr: FNR, type: 'person', ...ansvarligInfo }
})

const orgContract = (ansvarligInfo = {}) => ({
  _id: 'doc-2',
  ansvarligInfo: { navn: 'TELEMARK FYLKESKOMMUNE', fnr: ORGNR, type: 'organisasjon', ...ansvarligInfo }
})

describe('an organisation ansvarlig', () => {
  test('resolves from Enhetsregisteret and puts the orgnr in CompanyNo', async () => {
    const { deps } = makeDeps()

    const result = await resolveSubledgerRecipient(orgContract(), deps)
    const row = buildSubledgerRow(result.recipient, orgContract())

    assert.equal(result.ok, true)
    assert.equal(result.correctedType, undefined)
    assert.equal(row.CompanyNo, ORGNR)
    assert.equal(row.Description, 'TELEMARK FYLKESKOMMUNE')
    assert.equal(row['Street Address'], 'Postboks 2844')
    assert.equal(row['Zip Code'], '3702')
    assert.equal(row.City, 'SKIEN')
  })

  test('never calls FREG or KRR — an orgnr is meaningless to both', async () => {
    const { seen, deps } = makeDeps()

    await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(seen.freg, 0)
    assert.equal(seen.krr, 0)
    assert.equal(seen.brreg, 1)
  })

  test('an orgnr stored with type person still takes the org path, and asks for the type to be corrected', async () => {
    // The type backfill stamped 'person' on every older contract, orgs included.
    const { seen, deps } = makeDeps()

    const result = await resolveSubledgerRecipient(orgContract({ type: 'person' }), deps)
    const row = buildSubledgerRow(result.recipient, orgContract())

    assert.equal(seen.freg, 0)
    assert.equal(seen.brreg, 1)
    assert.equal(result.correctedType, 'organisasjon')
    assert.equal(row.Description, 'TELEMARK FYLKESKOMMUNE')
    assert.equal(row.City, 'SKIEN')
  })

  test('the admin-entered invoice e-mail beats whatever BRREG has', async () => {
    const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, epostadresse: 'postmottak@telemarkfylke.no' } })

    const { recipient } = await resolveSubledgerRecipient(orgContract({ epost: 'faktura@telemarkfylke.no' }), deps)

    assert.equal(recipient.email, 'faktura@telemarkfylke.no')
  })

  test('falls back to BRREG\'s e-mail when the admin left it Ukjent', async () => {
    const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, epostadresse: 'postmottak@telemarkfylke.no' } })

    const { recipient } = await resolveSubledgerRecipient(orgContract({ epost: 'Ukjent' }), deps)

    assert.equal(recipient.email, 'postmottak@telemarkfylke.no')
  })

  test('e-mail is null when neither the admin nor BRREG has one — the real TFK case', async () => {
    const { deps } = makeDeps()

    const { recipient } = await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(recipient.email, null)
  })

  test('is not-found when BRREG has nothing, without retrying', async () => {
    const { seen, deps } = makeDeps({ enhet: null })

    const result = await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
    assert.equal(seen.brreg, 1)
  })

  test('is lookup-failed after three attempts when BRREG cannot be reached', async () => {
    const { seen, deps } = makeDeps({ enhet: new Error('timeout') })

    const result = await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(result.reason, 'lookup-failed')
    assert.equal(seen.brreg, 3)
  })

  for (const [label, flags, expected] of [
    ['deleted', { slettedato: '2024-01-01' }, /slettet \(2024-01-01\)/],
    ['bankrupt', { konkurs: true }, /konkurs/],
    ['under forced dissolution', { underTvangsavviklingEllerTvangsopplosning: true }, /tvangsavvikling/],
    ['being wound up', { underAvvikling: true }, /under avvikling/]
  ]) {
    test(`is inactive-organisation and not exported when ${label}`, async () => {
      const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, ...flags } })

      const result = await resolveSubledgerRecipient(orgContract(), deps)

      assert.equal(result.ok, false)
      assert.equal(result.reason, 'inactive-organisation')
      assert.match(result.message, expected)
    })
  }
})

describe('needsManualReview', () => {
  const org = { isOrganisation: true, streetAddress: 'Postboks 2844', zipCode: '3702', city: 'SKIEN' }
  const person = { isOrganisation: false, streetAddress: 'Storgata 1', zipCode: '3900', city: 'Porsgrunn' }

  test('an organisation with a full address goes straight to import', () => {
    assert.equal(needsManualReview(org), false)
  })

  test('an organisation missing any address part goes to manual review', () => {
    assert.equal(needsManualReview({ ...org, streetAddress: null }), true)
    assert.equal(needsManualReview({ ...org, zipCode: null }), true)
    assert.equal(needsManualReview({ ...org, city: null }), true)
  })

  test('an organisation is not caught by the 9999 sentinel — that is a Folkeregister concept', () => {
    assert.equal(needsManualReview({ ...org, zipCode: '9999' }), false)
  })

  test('a person goes to manual review only on 9999', () => {
    assert.equal(needsManualReview(person), false)
    assert.equal(needsManualReview({ ...person, zipCode: '9999' }), true)
  })
})

describe('a person ansvarlig', () => {
  test('resolves through FREG and KRR', async () => {
    const { seen, deps } = makeDeps()

    const result = await resolveSubledgerRecipient(personContract(), deps)
    const row = buildSubledgerRow(result.recipient, personContract())

    assert.equal(seen.freg, 1)
    assert.equal(seen.krr, 1)
    assert.equal(seen.brreg, 0)
    assert.equal(row.CompanyNo, FNR)
    assert.equal(row.Description, 'Ola Nordmann')
    assert.equal(row['Street Address'], 'Storgata 1')
    assert.equal(row.Phone, '+4799999999')
    assert.equal(row['E-mail'], 'ola@example.no')
  })

  test('a LEGACY document with no type field takes the person path', async () => {
    const { seen, deps } = makeDeps()
    const legacy = { _id: 'legacy-1', ansvarligInfo: { navn: 'Ola Nordmann', fnr: FNR } }

    const result = await resolveSubledgerRecipient(legacy, deps)

    assert.equal(seen.freg, 1)
    assert.equal(seen.brreg, 0)
    assert.equal(result.recipient.companyNo, FNR)
  })

  test('prefers the D-number FREG returns over the fnr on the contract', async () => {
    const { deps } = makeDeps({ personData: { ...FREG_PERSON, foedselsEllerDNummer: D_NUMBER } })

    const { recipient } = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(recipient.companyNo, D_NUMBER)
  })

  test('a FREG error is retried three times, then reported as lookup-failed', async () => {
    const { seen, deps } = makeDeps({ personData: { status: 500, message: 'Internal server error' } })

    const result = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'lookup-failed')
    assert.equal(seen.freg, 3)
    assert.equal(seen.krr, 0)
  })

  test('a FREG error that clears on the second attempt resolves normally', async () => {
    const { seen, deps } = makeDeps({ personData: [{ status: 503 }, FREG_PERSON] })

    const result = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(result.ok, true)
    assert.equal(seen.freg, 2)
  })

  test('a FREG 404 is not-found and is not retried', async () => {
    const { seen, deps } = makeDeps({ personData: { status: 404, message: 'Not found' } })

    const result = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(result.reason, 'not-found')
    assert.equal(seen.freg, 1)
  })

  test('a KRR error is retried, then reported as lookup-failed', async () => {
    const { seen, deps } = makeDeps({ krrData: { status: 500, message: 'Internal server error' } })

    const result = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(result.reason, 'lookup-failed')
    assert.equal(seen.krr, 3)
  })

  test('a person with no KRR record still resolves, without e-mail or phone', async () => {
    const { deps } = makeDeps({ krrData: { personer: [] } })

    const result = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(result.ok, true)
    assert.equal(result.recipient.email, null)
    assert.equal(result.recipient.phone, null)
  })

  test('keeps the postnummer 9999 sentinel intact for the manual-review routing', async () => {
    const { deps } = makeDeps({
      personData: { ...FREG_PERSON, bostedsadresse: { gateadresse: 'X', postnummer: '9999', poststed: 'UKJENT' } }
    })

    const { recipient } = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(recipient.zipCode, '9999')
  })
})

describe('an invalid ansvarlig identifier', () => {
  for (const [label, fnr] of [
    ['Ukjent', 'Ukjent'],
    ['missing', undefined],
    ['10 digits', '0101900008'],
    ['11 digits with a bad checksum', '01019000084'],
    ['9 digits with a bad checksum', '929882988']
  ]) {
    test(`${label} is invalid-identifier and never looked up`, async () => {
      const { seen, deps } = makeDeps()

      const result = await resolveSubledgerRecipient(personContract({ fnr }), deps)

      assert.equal(result.ok, false)
      assert.equal(result.reason, 'invalid-identifier')
      assert.deepEqual(seen, { freg: 0, krr: 0, brreg: 0 })
    })
  }

  test('an fnr on a contract typed as organisasjon is invalid-identifier', async () => {
    const { seen, deps } = makeDeps()

    const result = await resolveSubledgerRecipient(orgContract({ fnr: FNR }), deps)

    assert.equal(result.reason, 'invalid-identifier')
    assert.deepEqual(seen, { freg: 0, krr: 0, brreg: 0 })
  })
})

describe('a contract whose ELEV is fiktiv', () => {
  test('is built purely from FREG + KRR, with no archive call — the ansvarlig is always ordinary', async () => {
    const { seen, deps } = makeDeps()
    const contract = {
      _id: 'doc-3',
      elevInfo: { navn: 'Fiktiv Elev', fnr: '12345678901', fnrType: 'fiktiv' },
      ansvarligInfo: { navn: 'Ola Nordmann', fnr: OTHER_FNR, type: 'person' }
    }

    const result = await resolveSubledgerRecipient(contract, deps)

    assert.equal(seen.freg, 1)
    assert.equal(seen.krr, 1)
    assert.equal(result.ok, true)
  })
})

describe('buildSubledgerRow', () => {
  test('emits exactly the columns the SL04-SYS template expects to be filled', () => {
    const row = buildSubledgerRow(
      { companyNo: '1', description: 'A', streetAddress: 'B', zipCode: 'C', city: 'D', email: 'E', phone: 'F' },
      { _id: 'x' }
    )

    assert.deepEqual(Object.keys(row).sort(), [
      'City', 'CompanyNo', 'Description', 'E-mail', 'End Of Line', 'Ledger Type Imp',
      'Notes', 'Phone', 'Street Address', 'UUID', 'Update Level', 'Zip Code'
    ])
  })

  test('carries the Mongo _id in UUID so the write-back can find the document', () => {
    const row = buildSubledgerRow({ companyNo: '1' }, { _id: 'doc-42' })
    assert.equal(row.UUID, 'doc-42')
  })
})

describe('buildFailureFacts', () => {
  test('lists lookup failures first', () => {
    const facts = buildFailureFacts([
      { id: 'a', reason: 'invalid-identifier', message: 'm', identifier: 'Ukjent' },
      { id: 'b', reason: 'lookup-failed', message: 'm', identifier: '010190*****' }
    ])

    assert.deepEqual(facts.map(fact => fact.title), ['b', 'a'])
    assert.match(facts[0].value, /^Oppslag feilet/)
  })

  test('caps the list and says how many were left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, reason: 'not-found', message: 'm', identifier: 'x' }))

    const facts = buildFailureFacts(many)

    assert.equal(facts.length, 51)
    assert.match(facts[50].value, /og 10 til/)
  })
})
