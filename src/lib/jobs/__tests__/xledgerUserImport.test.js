'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { resolveSubledgerRecipient, buildSubledgerRow } = require('../serverJobs/xledgerUserImport.js')

/**
 * The SL04-SYS path had no test coverage at all before this. It matters because it is the only
 * place both new features actually bite: the old code went straight to FREG + KRR and skipped any
 * document where either came back empty, so an organisation ansvarlig silently never reached
 * Xledger - and the invoice gate then held back every invoice for it, forever.
 */

const FREG_PERSON = {
  fulltnavn: 'OLA NORDMANN',
  foedselsEllerDNummer: '12345678901',
  bostedsadresse: { gateadresse: 'STORGATA 1', postnummer: '3900', poststed: 'PORSGRUNN' }
}

const KRR_DATA = { kontaktinformasjon: { epostadresse: 'ola@example.no', mobiltelefonnummer: '+4799999999' } }

// Matches the live Enhetsregisteret record: BRREG holds no e-mail or phone for Telemark
// fylkeskommune, which is the common case the admin-entered invoice address exists for.
const BRREG_ENHET = {
  orgnr: '929882989',
  navn: 'TELEMARK FYLKESKOMMUNE',
  adresse: { gateadresse: 'Postboks 2844', postnummer: '3702', poststed: 'SKIEN' },
  epostadresse: null,
  telefon: null
}

const makeDeps = ({ personData = FREG_PERSON, krrData = KRR_DATA, enhet = BRREG_ENHET } = {}) => {
  const seen = { freg: 0, krr: 0, brreg: 0 }
  return {
    seen,
    deps: {
      getPersonData: async () => { seen.freg++; return personData },
      getKRRData: async () => { seen.krr++; return krrData },
      lookupEnhet: async () => { seen.brreg++; return enhet }
    }
  }
}

const personContract = (ansvarligInfo = {}) => ({
  _id: 'doc-1',
  ansvarligInfo: { navn: 'Ola Nordmann', fnr: '12345678901', type: 'person', ...ansvarligInfo }
})

const orgContract = (ansvarligInfo = {}) => ({
  _id: 'doc-2',
  ansvarligInfo: { navn: 'TELEMARK FYLKESKOMMUNE', fnr: '929882989', type: 'organisasjon', ...ansvarligInfo }
})

describe('an organisation ansvarlig', () => {
  test('resolves from Enhetsregisteret and puts the orgnr in CompanyNo', async () => {
    const { deps } = makeDeps()

    const recipient = await resolveSubledgerRecipient(orgContract(), deps)
    const row = buildSubledgerRow(recipient, orgContract())

    assert.equal(row.CompanyNo, '929882989')
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

  test('the admin-entered invoice e-mail beats whatever BRREG has', async () => {
    // BRREG needs an address of its own here, or there is nothing for the admin's to beat.
    const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, epostadresse: 'postmottak@telemarkfylke.no' } })

    const recipient = await resolveSubledgerRecipient(orgContract({ epost: 'faktura@telemarkfylke.no' }), deps)

    assert.equal(recipient.email, 'faktura@telemarkfylke.no')
  })

  test('falls back to BRREG\'s e-mail when the admin left it Ukjent', async () => {
    const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, epostadresse: 'postmottak@telemarkfylke.no' } })

    const recipient = await resolveSubledgerRecipient(orgContract({ epost: 'Ukjent' }), deps)

    assert.equal(recipient.email, 'postmottak@telemarkfylke.no')
  })

  test('e-mail is null when neither the admin nor BRREG has one — the real TFK case', async () => {
    const { deps } = makeDeps()

    const recipient = await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(recipient.email, null)
  })

  test('is reported as unresolved rather than silently skipped when BRREG has nothing', async () => {
    const { deps } = makeDeps({ enhet: null })

    assert.equal(await resolveSubledgerRecipient(orgContract(), deps), null)
  })

  test('is never routed to manual review on the 9999 sentinel — that is a Folkeregister concept', async () => {
    const { deps } = makeDeps({ enhet: { ...BRREG_ENHET, adresse: { gateadresse: 'X', postnummer: '9999', poststed: 'Y' } } })

    const recipient = await resolveSubledgerRecipient(orgContract(), deps)

    assert.equal(recipient.isOrganisation, true)
  })
})

describe('an ordinary person ansvarlig is unchanged', () => {
  test('still resolves through FREG and KRR', async () => {
    const { seen, deps } = makeDeps()

    const recipient = await resolveSubledgerRecipient(personContract(), deps)
    const row = buildSubledgerRow(recipient, personContract())

    assert.equal(seen.freg, 1)
    assert.equal(seen.krr, 1)
    assert.equal(seen.brreg, 0)
    assert.equal(row.CompanyNo, '12345678901')
    assert.equal(row.Description, 'Ola Nordmann')
    assert.equal(row['Street Address'], 'Storgata 1')
    assert.equal(row.Phone, '+4799999999')
    assert.equal(row['E-mail'], 'ola@example.no')
  })

  test('a LEGACY document with no type field still takes the person path', async () => {
    // Every contract written before this feature, and every un-backfilled invoice.recipient.
    const { seen, deps } = makeDeps()
    const legacy = { _id: 'legacy-1', ansvarligInfo: { navn: 'Ola Nordmann', fnr: '12345678901' } }

    const recipient = await resolveSubledgerRecipient(legacy, deps)

    assert.equal(seen.freg, 1)
    assert.equal(seen.brreg, 0)
    assert.equal(recipient.companyNo, '12345678901')
  })

  test('prefers the D-number FREG returns over the fnr on the contract', async () => {
    const { deps } = makeDeps({ personData: { ...FREG_PERSON, foedselsEllerDNummer: '52345678901' } })

    const recipient = await resolveSubledgerRecipient(personContract(), deps)

    assert.equal(recipient.companyNo, '52345678901')
  })

  test('returns null when FREG or KRR has nothing, so the caller can report it', async () => {
    const noFreg = makeDeps({ personData: null })
    const noKrr = makeDeps({ krrData: null })

    assert.equal(await resolveSubledgerRecipient(personContract(), noFreg.deps), null)
    assert.equal(await resolveSubledgerRecipient(personContract(), noKrr.deps), null)
  })

  test('keeps the postnummer 9999 sentinel intact for the manual-review routing', async () => {
    const { deps } = makeDeps({
      personData: { ...FREG_PERSON, bostedsadresse: { gateadresse: 'X', postnummer: '9999', poststed: 'UKJENT' } }
    })

    const recipient = await resolveSubledgerRecipient(personContract(), deps)

    // Previously toProperCase() was applied to the zip before comparing — a no-op on digits, but it
    // made the sentinel check read as though it might not be.
    assert.equal(recipient.zipCode, '9999')
  })
})

describe('a contract whose ELEV is fiktiv', () => {
  test('is built purely from FREG + KRR, with no archive call — the ansvarlig is always ordinary', async () => {
    const { seen, deps } = makeDeps()
    const contract = {
      _id: 'doc-3',
      elevInfo: { navn: 'Fiktiv Elev', fnr: '12345678901', fnrType: 'fiktiv' },
      ansvarligInfo: { navn: 'Ola Nordmann', fnr: '10987654321', type: 'person' }
    }

    const recipient = await resolveSubledgerRecipient(contract, deps)

    assert.equal(seen.freg, 1)
    assert.equal(seen.krr, 1)
    assert.equal(recipient.companyNo, '12345678901')
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

  test('has no duplicate City key — the old literals set it twice', () => {
    const row = buildSubledgerRow({ city: 'PORSGRUNN' }, { _id: 'x' })
    assert.equal(row.City, 'PORSGRUNN')
  })

  test('carries the Mongo _id in UUID so the write-back can find the document', () => {
    const row = buildSubledgerRow({ companyNo: '1' }, { _id: 'doc-42' })
    assert.equal(row.UUID, 'doc-42')
  })
})
