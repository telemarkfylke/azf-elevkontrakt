'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { assertManualContractAllowed } = require('../assertManualContractAllowed.js')

const ORDINARY = {
  ok: true,
  type: 'fnr',
  identifier: '12345678901',
  fnrType: 'ordinær',
  canBeElev: true,
  school: { navn: 'Bamble videregående skole', orgNr: '974574943' }
}

const FIKTIV = { ...ORDINARY, fnrType: 'fiktiv', school: null }
const NO_FINT_SCHOOL = { ...ORDINARY, school: null }

/** @param {Object|Error} classification - resolved value, or an Error to throw */
const makeDeps = (classification = ORDINARY) => {
  const seen = { classify: 0 }
  return {
    seen,
    deps: {
      classifyIdentifier: async () => {
        seen.classify++
        if (classification instanceof Error) throw classification
        return classification
      }
    }
  }
}

const contract = (extra = {}) => ({ fnr: '12345678901', ansvarligType: 'person', foresattFnr: '10987654321', ...extra })

describe('administrators are unaffected', () => {
  test('a fiktiv elev with an org ansvarlig and no FINT school is allowed, and nothing is looked up', async () => {
    const { seen, deps } = makeDeps(FIKTIV)

    const refusal = await assertManualContractAllowed(
      contract({ elevFnrType: 'fiktiv', ansvarligType: 'organisasjon', foresattFnr: '974574943' }),
      true,
      deps
    )

    assert.equal(refusal, null)
    // The admin path must not pay for the classification - it is the common case.
    assert.equal(seen.classify, 0)
  })
})

describe('organisasjon as ansvarlig is administrator-only', () => {
  test('refused when the payload declares it', async () => {
    const { seen, deps } = makeDeps()

    const refusal = await assertManualContractAllowed(contract({ ansvarligType: 'organisasjon', foresattFnr: '974574943' }), false, deps)

    assert.equal(refusal.status, 403)
    assert.equal(refusal.reason, 'requires-admin')
    assert.match(refusal.error, /virksomhet/)
    // Refused on the payload alone, so no upstream call is needed.
    assert.equal(seen.classify, 0)
  })

  test('refused on a 9-digit foresattFnr even when ansvarligType is left out', async () => {
    // The bypass this arm exists for: omit the type and the orgnr would go down the person path.
    const { deps } = makeDeps()

    const refusal = await assertManualContractAllowed({ fnr: '12345678901', foresattFnr: '974574943' }, false, deps)

    assert.equal(refusal.status, 403)
    assert.equal(refusal.reason, 'requires-admin')
  })

  test('an 11-digit foresattFnr is not mistaken for an organisation', async () => {
    const { deps } = makeDeps()

    const refusal = await assertManualContractAllowed(contract(), false, deps)

    assert.equal(refusal, null)
  })
})

describe('fiktivt fødselsnummer is administrator-only', () => {
  test('refused, and the payload cannot hide it', async () => {
    // elevFnrType says 'ordinær'; the classification is what decides.
    const { seen, deps } = makeDeps(FIKTIV)

    const refusal = await assertManualContractAllowed(contract({ elevFnrType: 'ordinær' }), false, deps)

    assert.equal(refusal.status, 403)
    assert.equal(refusal.reason, 'requires-admin')
    assert.match(refusal.error, /fiktivt fødselsnummer/)
    assert.equal(seen.classify, 1)
  })
})

describe('a hand-picked school is administrator-only', () => {
  test('refused when FINT has no active elevforhold to supply one', async () => {
    const { deps } = makeDeps(NO_FINT_SCHOOL)

    const refusal = await assertManualContractAllowed(contract({ schoolOrgNumber: '974574943' }), false, deps)

    assert.equal(refusal.status, 403)
    assert.equal(refusal.reason, 'requires-admin')
    assert.match(refusal.error, /VIS/)
  })

  test('a school FINT knows about is fine for a non-administrator', async () => {
    const { deps } = makeDeps(ORDINARY)

    const refusal = await assertManualContractAllowed(contract(), false, deps)

    assert.equal(refusal, null)
  })
})

describe('a failed classification is not reported as a permission problem', () => {
  test('an unreachable archive keeps its own reason and status', async () => {
    // Otherwise an outage tells a non-admin they lack access to their own ordinary student.
    const { deps } = makeDeps({ ok: false, reason: 'lookup-failed', error: 'Arkivet kunne ikke nås. Prøv igjen.' })

    const refusal = await assertManualContractAllowed(contract(), false, deps)

    assert.equal(refusal.status, 502)
    assert.equal(refusal.reason, 'lookup-failed')
  })

  test('an unknown number is a 404, not a 403', async () => {
    const { deps } = makeDeps({ ok: false, reason: 'not-found', error: 'Fant ikke personen' })

    const refusal = await assertManualContractAllowed(contract(), false, deps)

    assert.equal(refusal.status, 404)
    assert.equal(refusal.reason, 'not-found')
  })

  test('a thrown classification becomes a 502, never an allow', async () => {
    const { deps } = makeDeps(new Error('socket hang up'))

    const refusal = await assertManualContractAllowed(contract(), false, deps)

    assert.equal(refusal.status, 502)
    assert.notEqual(refusal, null)
  })
})

describe('missing elev fnr', () => {
  test('is reported as a bad contract rather than a permission problem', async () => {
    const { seen, deps } = makeDeps()

    const refusal = await assertManualContractAllowed({ ansvarligType: 'person', foresattFnr: '10987654321' }, false, deps)

    assert.equal(refusal.status, 400)
    assert.equal(refusal.reason, 'invalid-contract')
    assert.equal(seen.classify, 0)
  })
})
