'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { postManualContract } = require('../queryMongoDB.js')

/**
 * The ansvarlig rule is the one place these two features can produce a contract nobody can be
 * invoiced for, so it gets its own suite.
 *
 * Two invariants:
 *   1. A fiktivt fødselsnummer may be the elev, never the ansvarlig - it cannot become an Xledger
 *      customer, so an invoice against it would be held back forever.
 *   2. Therefore a fiktiv elev always needs a separate ansvarlig, INCLUDING when they are 18+ and
 *      would normally become their own ansvarlig.
 */

const ARCHIVE_DATA = { DocumentNumber: '23/00077-60' }

const baseContract = (overrides = {}) => ({
  type: 'Leieavtale',
  fnr: '12345678901',
  foresattFnr: '10987654321',
  schoolOrgNumber: '974568098',
  ...overrides
})

/**
 * A mongo double that records inserts instead of performing them, plus spies on the FINT/FREG/
 * archive lookups so the tests can assert which ones were reached.
 */
const makeDeps = ({ studentFound = true, personFound = true, archivePerson = null, enhet = { navn: 'TELEMARK FYLKESKOMMUNE' }, brregThrows = false } = {}) => {
  const seen = { student: [], person: [], archive: [], enhet: [], inserted: [] }

  const collection = () => ({
    insertOne: async (document) => { seen.inserted.push(document); return { acknowledged: true, insertedId: 'id' } },
    findOne: async () => null,
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] }),
    countDocuments: async () => 0
  })

  return {
    seen,
    deps: {
      getMongoClient: async () => ({ db: () => ({ collection }) }),
      student: async (fnr) => {
        seen.student.push(fnr)
        return studentFound
          ? { navn: 'Test Elev', fornavn: 'Test', etternavn: 'Elev', upn: 'test@x.no', elevnummer: 'E1' }
          : { status: 404 }
      },
      person: async (fnr) => {
        seen.person.push(fnr)
        return personFound ? { fulltnavn: 'Test Foresatt', foedselsEllerDNummer: fnr } : {}
      },
      readElevMappe: async (ssn) => {
        seen.archive.push(ssn)
        if (!archivePerson) throw new Error('Kunne ikke nå arkivet')
        return { privatePerson: archivePerson }
      },
      // Must be stubbed even where unused, or the org cases hit the real BRREG over the network.
      lookupEnhet: async (orgnr) => {
        seen.enhet.push(orgnr)
        if (brregThrows) throw new Error('Kunne ikke nå Enhetsregisteret')
        return enhet
      }
    }
  }
}

describe('a fiktiv elev must have an ansvarlig — even at 18+', () => {
  test('is REJECTED when no ansvarlig is given', async () => {
    const { seen, deps } = makeDeps()

    const result = await postManualContract(
      baseContract({ elevFnrType: 'fiktiv', foresattFnr: '' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(result.status, 400)
    assert.match(result.error, /må ha en ansvarlig/)
    assert.equal(seen.inserted.length, 0, 'no contract may be written')
  })

  test('the self-ansvarlig fallback must NOT fire for a fiktiv elev', async () => {
    // Without the guard, queryMongoDB falls back to person(contract.fnr) and the fiktiv identifier
    // silently becomes the invoice recipient.
    const { seen, deps } = makeDeps()

    await postManualContract(
      baseContract({ elevFnrType: 'fiktiv', foresattFnr: '' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(seen.person.length, 0, 'FREG must never be asked about the fiktiv fnr as ansvarlig')
  })

  test('is rejected the same way whether the elev is under or over 18', async () => {
    for (const isUnder18 of [true, false]) {
      const { deps } = makeDeps()
      const result = await postManualContract(
        baseContract({ elevFnrType: 'fiktiv', foresattFnr: '', isUnder18 }),
        ARCHIVE_DATA, false, deps
      )
      assert.equal(result.status, 400, `should reject regardless of age (isUnder18: ${isUnder18})`)
    }
  })

  test('is ACCEPTED with an ordinary-fnr ansvarlig', async () => {
    const { seen, deps } = makeDeps()

    const result = await postManualContract(
      baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps
    )

    assert.equal(result.status, undefined)
    assert.equal(seen.inserted.length, 1)
    assert.equal(seen.inserted[0].elevInfo.fnrType, 'fiktiv')
    assert.equal(seen.inserted[0].ansvarligInfo.type, 'person')
    assert.equal(seen.inserted[0].ansvarligInfo.fnr, '10987654321')
  })

  test('is ACCEPTED with an organisation as ansvarlig — the two features compose', async () => {
    const { seen, deps } = makeDeps()

    const result = await postManualContract(
      baseContract({
        elevFnrType: 'fiktiv',
        ansvarligType: 'organisasjon',
        ansvarligNavn: 'TELEMARK FYLKESKOMMUNE',
        foresattFnr: '929882989'
      }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(result.status, undefined)
    assert.equal(seen.inserted[0].elevInfo.fnrType, 'fiktiv')
    assert.equal(seen.inserted[0].ansvarligInfo.type, 'organisasjon')
    assert.equal(seen.inserted[0].ansvarligInfo.fnr, '929882989')
  })
})

describe('an organisation ansvarlig never goes near FREG', () => {
  test('no FREG lookup is made for the organisation', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'TELEMARK FYLKESKOMMUNE', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(seen.person.length, 0, 'an organisasjonsnummer is meaningless to FREG')
  })

  test('no "Ansvarlig ikke funnet i FREG" error is recorded', async () => {
    // FREG returning nothing is expected for an organisation; recording it as an error would put a
    // permanent bogus entry on every org contract.
    const { seen, deps } = makeDeps({ personFound: false })

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'TELEMARK FYLKESKOMMUNE', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    const errors = seen.inserted[0].error
    assert.equal(errors.some(e => /Ansvarlig ikke funnet/.test(e.error)), false, JSON.stringify(errors))
  })

  test('signedBy is the organisation itself', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'TELEMARK FYLKESKOMMUNE', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.deepEqual(seen.inserted[0].signedBy, { navn: 'TELEMARK FYLKESKOMMUNE', fnr: '929882989' })
  })
})

/**
 * The name reaches an invoice, so it must be the register's, not the request body's. /SyncEnterprise
 * proves the orgnr at archive time; nothing ever proved the name.
 */
describe('the organisation name comes from Enhetsregisteret, not the request', () => {
  test('BRREG overrides a name the caller made up', async () => {
    const { seen, deps } = makeDeps({ enhet: { navn: 'TELEMARK FYLKESKOMMUNE' } })

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'NOE HELT ANNET AS', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.deepEqual(seen.enhet, ['929882989'])
    assert.equal(seen.inserted[0].ansvarligInfo.navn, 'TELEMARK FYLKESKOMMUNE')
  })

  test('signedBy gets the verified name too — it is the same organisation', async () => {
    const { seen, deps } = makeDeps({ enhet: { navn: 'TELEMARK FYLKESKOMMUNE' } })

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'NOE HELT ANNET AS', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(seen.inserted[0].signedBy.navn, 'TELEMARK FYLKESKOMMUNE')
  })

  test('the admin-entered invoice e-mail is NOT overridden', async () => {
    // BRREG's epostadresse is a generic firmapost and often missing, so the admin's wins.
    const { seen, deps } = makeDeps({ enhet: { navn: 'TELEMARK FYLKESKOMMUNE', epostadresse: 'post@tfk.no' } })

    await postManualContract(
      baseContract({
        ansvarligType: 'organisasjon',
        ansvarligNavn: 'TELEMARK FYLKESKOMMUNE',
        ansvarligEpost: 'faktura.avdeling@tfk.no',
        foresattFnr: '929882989'
      }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(seen.inserted[0].ansvarligInfo.epost, 'faktura.avdeling@tfk.no')
  })

  test('a BRREG outage falls back to the submitted name and records it', async () => {
    // The archive already proved the org exists, so a BRREG hiccup must not lose the contract -
    // but the name is then unverified and must say so.
    const { seen, deps } = makeDeps({ brregThrows: true })

    const result = await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'TELEMARK FYLKESKOMMUNE', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(result.status, undefined, 'the contract is still created')
    assert.equal(seen.inserted[0].ansvarligInfo.navn, 'TELEMARK FYLKESKOMMUNE')
    assert.equal(seen.inserted[0].error.some(e => /Kunne ikke verifisere organisasjonsnavnet/.test(e.error)), true)
  })

  test('an orgnr BRREG does not know is recorded rather than silently accepted', async () => {
    const { seen, deps } = makeDeps({ enhet: null })

    await postManualContract(
      baseContract({ ansvarligType: 'organisasjon', ansvarligNavn: 'TELEMARK FYLKESKOMMUNE', foresattFnr: '929882989' }),
      ARCHIVE_DATA, false, deps
    )

    assert.equal(seen.inserted[0].error.some(e => /Fant ikke organisasjonen i Enhetsregisteret/.test(e.error)), true)
  })

  test('a person ansvarlig never touches Enhetsregisteret', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, false, deps)

    assert.deepEqual(seen.enhet, [])
  })
})

describe('a fiktiv elev that FINT does not know', () => {
  test('takes the name from the archive rather than leaving it Ukjent', async () => {
    const { seen, deps } = makeDeps({
      studentFound: false,
      archivePerson: { ssn: '12345678901', name: 'Ola Nordmann', firstName: 'Ola', lastName: 'Nordmann' }
    })

    await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    assert.deepEqual(seen.archive, ['12345678901'])
    assert.equal(seen.inserted[0].elevInfo.navn, 'Ola Nordmann')
    assert.equal(seen.inserted[0].elevInfo.fnrType, 'fiktiv')
  })

  test('does NOT fall through to FREG — a fiktiv fnr is not there by definition', async () => {
    const { seen, deps } = makeDeps({
      studentFound: false,
      archivePerson: { name: 'Ola Nordmann', firstName: 'Ola', lastName: 'Nordmann' }
    })

    await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    // The only FREG call should be for the ansvarlig, never for the fiktiv elev.
    assert.deepEqual(seen.person, ['10987654321'])
  })

  test('does not push the misleading "Elev ikke funnet" error', async () => {
    const { seen, deps } = makeDeps({
      studentFound: false,
      archivePerson: { name: 'Ola Nordmann', firstName: 'Ola', lastName: 'Nordmann' }
    })

    await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    assert.equal(seen.inserted[0].error.some(e => e.error === 'Elev ikke funnet'), false)
  })

  test('a failed archive lookup REFUSES rather than writing a nameless contract', async () => {
    // Last source that can name a fiktiv elev. Falling through leaves elevInfo entirely 'Ukjent',
    // and no repair job can guess the name afterwards.
    const { seen, deps } = makeDeps({ studentFound: false, archivePerson: null })

    const result = await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    assert.equal(result.status, 502)
    assert.match(result.error, /Kunne ikke hente elevdata fra arkivet/)
    assert.equal(seen.inserted.length, 0, 'no contract may be written')
  })

  test('502, not 400 — the number is fine, the archive is not', async () => {
    // An unknown fiktiv fnr is already rejected in readElevMappe, so this branch means retry.
    const { deps } = makeDeps({ studentFound: false, archivePerson: null })

    const result = await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    assert.equal(result.status, 502)
  })
})

describe('ordinary contracts are unchanged', () => {
  test('an ordinary elev with a guardian still looks up FINT and FREG as before', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, false, deps)

    assert.deepEqual(seen.student, ['12345678901'])
    assert.deepEqual(seen.person, ['10987654321'])
    assert.equal(seen.archive.length, 0, 'the archive is not consulted for an ordinary contract')
    assert.equal(seen.inserted[0].ansvarligInfo.type, 'person')
    assert.equal(seen.inserted[0].elevInfo.fnrType, 'ordinær')
  })

  test('an ordinary elev over 18 still becomes their own ansvarlig', async () => {
    const { seen, deps } = makeDeps()

    const result = await postManualContract(baseContract({ foresattFnr: '' }), ARCHIVE_DATA, false, deps)

    assert.equal(result.status, undefined)
    assert.deepEqual(seen.person, ['12345678901'], 'falls back to the student themselves')
  })
})
