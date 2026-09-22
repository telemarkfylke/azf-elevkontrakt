'use strict'

/**
 * handleDbRequest called `postManualContract(jsonBody, archive)` with two arguments, so isMock was
 * always undefined - a mock run archived REAL documents in P360 and wrote to the REAL collection.
 *
 * The route half (skipping archiveDocument for a mock request) is not covered here: app.http
 * registers at require time and there is no harness for driving a route. It is guarded indirectly
 * by the last test, which pins the stub shape the route has to supply.
 */

// Must be set before config.js loads, or both collection names resolve to 'undefined' and the two
// branches become indistinguishable.
process.env.MONGODB_CONTRACTS_COLLECTION = 'kontrakter'
process.env.MONGODB_CONTRACTS_MOCK_COLLECTION = 'kontrakter-mock'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { postManualContract } = require('../queryMongoDB.js')

const ARCHIVE_DATA = { DocumentNumber: '23/00077-60' }

const baseContract = (overrides = {}) => ({
  type: 'Leieavtale',
  fnr: '12345678901',
  foresattFnr: '10987654321',
  schoolOrgNumber: '974568098',
  ...overrides
})

/** As postManualContractAnsvarlig.test.js, but recording which collection each insert went to. */
const makeDeps = () => {
  const seen = { student: [], person: [], insertedInto: [] }

  return {
    seen,
    deps: {
      getMongoClient: async () => ({
        db: () => ({
          collection: (name) => ({
            insertOne: async (document) => {
              seen.insertedInto.push({ collection: name, document })
              return { acknowledged: true, insertedId: 'id' }
            },
            findOne: async () => null,
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] }),
            countDocuments: async () => 0
          })
        })
      }),
      student: async (fnr) => {
        seen.student.push(fnr)
        return { navn: 'Test Elev', fornavn: 'Test', etternavn: 'Elev', upn: 'test@x.no', elevnummer: 'E1' }
      },
      person: async (fnr) => {
        seen.person.push(fnr)
        return { fulltnavn: 'Test Foresatt', foedselsEllerDNummer: fnr }
      },
      readElevMappe: async () => { throw new Error('the archive must not be consulted here') }
    }
  }
}

describe('isMock routes the contract away from production', () => {
  test('isMock true writes to the mock collection, never to kontrakter', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, true, deps)

    assert.equal(seen.insertedInto.length, 1)
    assert.equal(seen.insertedInto[0].collection, 'kontrakter-mock')
  })

  test('isMock false writes to the real collection — the existing behaviour is untouched', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, false, deps)

    assert.equal(seen.insertedInto[0].collection, 'kontrakter')
  })

  test('a MISSING isMock still writes to the real collection', async () => {
    // The bug was the missing argument, not a wrong value.
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, undefined, deps)

    assert.equal(seen.insertedInto[0].collection, 'kontrakter')
  })
})

describe('a mock contract does not reach the external lookups', () => {
  test('neither FINT nor FREG is called', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, true, deps)

    assert.deepEqual(seen.student, [], 'FINT must not be asked about mock data')
    assert.deepEqual(seen.person, [], 'FREG must not be asked about mock data')
  })

  test('an ordinary contract still calls both, so the skip is genuinely mock-only', async () => {
    const { seen, deps } = makeDeps()

    await postManualContract(baseContract(), ARCHIVE_DATA, false, deps)

    assert.deepEqual(seen.student, ['12345678901'])
    assert.deepEqual(seen.person, ['10987654321'])
  })
})

describe('the archive stub the route substitutes for a mock run', () => {
  test('a DocumentNumber is required, which is why the stub carries one', async () => {
    // If the route's stub ever loses its DocumentNumber, this is the refusal it hits.
    const { seen, deps } = makeDeps()

    const result = await postManualContract(baseContract(), {}, true, deps)

    assert.equal(result.status, 400)
    assert.match(result.error, /archiveData/i)
    assert.equal(seen.insertedInto.length, 0, 'nothing may be written without archive data')
  })

  test('the stub shape the route builds is accepted', async () => {
    const { seen, deps } = makeDeps()

    const stub = { Recno: 0, DocumentNumber: 'MOCK-00000-0', ImportedDocumentNumber: null, UID: 'x', UIDOrigin: 'mock' }
    await postManualContract(baseContract(), stub, true, deps)

    assert.equal(seen.insertedInto.length, 1)
    // A manual contract is signed by definition, so the number lands on signedSkjemaInfo.
    assert.equal(seen.insertedInto[0].document.signedSkjemaInfo.archiveDocumentNumber, 'MOCK-00000-0')
  })
})
