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
const makeDeps = ({ studentFound = true, personFound = true, archivePerson = null } = {}) => {
  const seen = { student: [], person: [], archive: [], inserted: [] }

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

  test('records an error when the archive lookup itself fails, but still writes the contract', async () => {
    // The archive already confirmed this person during the /checkIdentifier step; a failure here is
    // a transient archive problem, not grounds to lose an otherwise valid contract.
    const { seen, deps } = makeDeps({ studentFound: false, archivePerson: null })

    await postManualContract(baseContract({ elevFnrType: 'fiktiv' }), ARCHIVE_DATA, false, deps)

    assert.equal(seen.inserted.length, 1)
    assert.equal(seen.inserted[0].error.some(e => /arkivoppslag feilet/.test(e.error)), true)
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
