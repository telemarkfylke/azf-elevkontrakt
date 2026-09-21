'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { classifyIdentifier } = require('../classifyIdentifier.js')
const { ArchiveLookupError } = require('../queryArchive.js')

// isElevforholdActive needs both ends of gyldighetsperiode and an overlap with the current school
// year, so the window is derived from the clock rather than hardcoded (same approach as
// isElevforholdActive.test.js).
const CURRENT_YEAR = new Date().getFullYear()
const FINT_HIT = {
  navn: 'Ola Nordmann',
  elevforhold: [{
    gyldighetsperiode: { start: `${CURRENT_YEAR - 1}-08-01T00:00:00Z`, slutt: `${CURRENT_YEAR + 1}-07-31T00:00:00Z` },
    kategori: { navn: 'Elev' },
    skole: { navn: 'Bamble videregående skole', skolenummer: '12345' }
  }]
}

const FREG_HIT = { fulltnavn: 'Ola Nordmann', foedselsEllerDNummer: '12345678901' }

const ARCHIVE_HIT = {
  privatePerson: { ssn: '12345678901', name: 'Ola Nordmann', firstName: 'Ola', lastName: 'Nordmann', streetAddress: 'Storgata 1', zipCode: '3900', zipPlace: 'PORSGRUNN' },
  elevmappe: { Recno: 1, CaseNumber: '23/00077' }
}

const notFound = () => new ArchiveLookupError('not-found', 'Fant ikke personen i Folkeregisteret eller arkivet')

/**
 * @param {Object} opts - fint/freg/archive each either a value to resolve or an Error to throw
 */
const makeDeps = ({ fint = null, freg = null, archive = notFound(), enhet = null } = {}) => {
  const seen = { fint: 0, freg: 0, archive: 0, enhet: 0 }
  return {
    seen,
    deps: {
      student: async () => { seen.fint++; return fint || { status: 404 } },
      person: async () => { seen.freg++; return freg || {} },
      readElevMappe: async () => {
        seen.archive++
        if (archive instanceof Error) throw archive
        return archive
      },
      lookupEnhet: async () => {
        seen.enhet++
        if (enhet instanceof Error) throw enhet
        return enhet
      }
    }
  }
}

describe('FREG is the discriminator, not FINT', () => {
  test('FINT hit + FREG hit => ordinær, and the archive is never consulted', async () => {
    const { seen, deps } = makeDeps({ fint: FINT_HIT, freg: FREG_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.ok, true)
    assert.equal(result.fnrType, 'ordinær')
    assert.equal(result.source, 'freg')
    assert.equal(seen.archive, 0)
  })

  test('FINT hit + FREG MISS + archive hit => fiktiv', async () => {
    // The central case. A student with a fiktivt fnr is enrolled in FINT like anyone else, so a
    // FINT hit must never be read as proof of an ordinary fødselsnummer.
    const { seen, deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.ok, true)
    assert.equal(result.fnrType, 'fiktiv')
    assert.equal(result.source, 'arkiv')
    assert.equal(result.isStudent, true)
    assert.equal(seen.archive, 1)
  })

  test('FINT hit + FREG miss + archive MISS => rejected, despite the FINT record', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: notFound() })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
    // The message should mention the FINT record so the admin knows what they are looking at.
    assert.match(result.error, /skoleadministrativt system/)
  })

  test('FINT miss + FREG hit => an ordinary person who is not a student', async () => {
    const { deps } = makeDeps({ fint: null, freg: FREG_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.ok, true)
    assert.equal(result.fnrType, 'ordinær')
    assert.equal(result.isStudent, false)
  })

  test('FINT miss + FREG miss + archive miss => rejected', async () => {
    const { deps } = makeDeps({ fint: null, freg: null, archive: notFound() })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
    assert.match(result.error, /Folkeregisteret eller arkivet/)
  })

  test('a typo of a real fnr is rejected rather than becoming a fictitious person', async () => {
    const { deps } = makeDeps({ fint: null, freg: null, archive: notFound() })

    const result = await classifyIdentifier('12345678902', deps)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
  })
})

describe('failures must stay distinguishable from a bad number', () => {
  test('an unreachable archive is lookup-failed, NOT not-found', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: new Error('Kunne ikke nå arkivet') })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.reason, 'lookup-failed')
    assert.match(result.error, /Arkivet kunne ikke nås/)
    assert.doesNotMatch(result.error, /Kontroller nummeret/)
  })

  test('a missing CaseNumber is its own reason, aimed at an archive administrator', async () => {
    const { deps } = makeDeps({
      fint: FINT_HIT,
      freg: null,
      archive: new ArchiveLookupError('no-case-number', 'Elevmappen mangler saksnummer og må rettes i arkivet av en arkivansvarlig')
    })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.reason, 'no-case-number')
    assert.match(result.error, /arkivansvarlig/)
  })

  test('an unreachable BRREG is lookup-failed, not "no such company"', async () => {
    const { deps } = makeDeps({ enhet: new Error('Kunne ikke nå Enhetsregisteret') })

    const result = await classifyIdentifier('929882989', deps)

    assert.equal(result.reason, 'lookup-failed')
  })
})

describe('organisations', () => {
  test('a valid orgnr resolves and may be ansvarlig but never elev', async () => {
    const { deps } = makeDeps({ enhet: { orgnr: '929882989', navn: 'TELEMARK FYLKESKOMMUNE', slettedato: null } })

    const result = await classifyIdentifier('929882989', deps)

    assert.equal(result.ok, true)
    assert.equal(result.type, 'orgnr')
    assert.equal(result.canBeAnsvarlig, true)
    assert.equal(result.canBeElev, false, 'an organisation can never be the student')
  })

  test('a deleted organisation cannot be ansvarlig', async () => {
    const { deps } = makeDeps({ enhet: { orgnr: '929882989', navn: 'GAMMELT AS', slettedato: '2020-01-01' } })

    const result = await classifyIdentifier('929882989', deps)

    assert.equal(result.canBeAnsvarlig, false)
  })

  test('a bad checksum is rejected before BRREG is called', async () => {
    const { seen, deps } = makeDeps()

    const result = await classifyIdentifier('929882988', deps)

    assert.equal(result.reason, 'invalid-format')
    assert.equal(seen.enhet, 0)
  })

  test('an unknown orgnr is not-found', async () => {
    const { deps } = makeDeps({ enhet: null })

    const result = await classifyIdentifier('929882989', deps)

    assert.equal(result.reason, 'not-found')
  })
})

describe('a fiktiv fnr may be the elev but never the ansvarlig', () => {
  test('canBeAnsvarlig is false for a confirmed fiktiv person', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.canBeElev, true)
    assert.equal(result.canBeAnsvarlig, false, 'a fiktiv fnr cannot become an Xledger customer')
  })

  test('name and address come from the archive, never from the caller', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.navn, 'Ola Nordmann')
    assert.deepEqual(result.adresse, { gateadresse: 'Storgata 1', postnummer: '3900', poststed: 'PORSGRUNN' })
  })
})

describe('school resolution decides whether the admin gets asked', () => {
  test('a school from FINT is returned, so no selector is needed', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.school.navn, 'Bamble videregående skole')
    assert.equal(result.school.orgNr, '974568098')
  })

  test('no active elevforhold means no school, and the frontend must ask', async () => {
    const fint = { navn: 'Ola', elevforhold: [] }
    const { deps } = makeDeps({ fint, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.school, null)
  })

  test('a fiktiv student normally DOES have a school — the selector is the rare path', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: null, archive: ARCHIVE_HIT })

    const result = await classifyIdentifier('12345678901', deps)

    assert.equal(result.fnrType, 'fiktiv')
    assert.notEqual(result.school, null)
  })
})

describe('malformed input', () => {
  test('rejects anything that is neither 11 nor 9 digits', async () => {
    const { seen, deps } = makeDeps()

    for (const bad of ['123', '1234567890', '123456789012', 'abcdefghijk', '']) {
      const result = await classifyIdentifier(bad, deps)
      assert.equal(result.reason, 'invalid-format', `expected ${bad} to be rejected`)
    }
    assert.equal(seen.fint + seen.freg + seen.archive + seen.enhet, 0, 'nothing should be looked up')
  })

  test('accepts pasted formatting', async () => {
    const { deps } = makeDeps({ fint: FINT_HIT, freg: FREG_HIT })

    const result = await classifyIdentifier('123456 78901', deps)

    assert.equal(result.ok, true)
    assert.equal(result.identifier, '12345678901')
  })
})
