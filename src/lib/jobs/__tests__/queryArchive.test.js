'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  archiveDocument,
  syncElevMappe,
  syncPrivatePerson,
  syncEnterprise,
  readElevMappe,
  getCaseNumber,
  findSchool,
  isPersonNotFoundError,
  ArchiveLookupError
} = require('../queryArchive.js')

// The archive's own not-found body, copied verbatim from azf-archive-v2 (lib/freg.js:9 surfacing
// through lib/http-response.js:14-19).
const NOT_FOUND_BODY = {
  message: 'Error: Could not find anyone with that ssn 11111111111, did someone prank you?',
  data: 'Error: Could not find anyone with that ssn 11111111111, did someone prank you?\n    at fregSsn (/home/site/wwwroot/lib/freg.js:9:41)'
}

const archiveError = (status, body) => {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status, data: body }
  return error
}

const okElevmappe = {
  privatePerson: { ssn: '12345678901', name: 'Ola Nordmann', streetAddress: 'Storgata 1', zipCode: '3900', zipPlace: 'PORSGRUNN' },
  elevmappe: { Recno: 123, CaseNumber: '23/00077' }
}

/**
 * Records what was posted where, so the tests can assert on the request body without MSAL or a
 * network. Mirrors the deps-injection style used by xledgerExtraInvoice.
 */
const makeArchive = (handler) => {
  const calls = []
  const callArchive = async (endpoint, body) => {
    calls.push({ endpoint, body })
    return handler(endpoint, body)
  }
  return { calls, deps: { callArchive } }
}

const respondWith = (value) => () => value
const failWith = (error) => () => { throw error }

describe('isPersonNotFoundError', () => {
  test('matches the archive\'s unknown-ssn body', () => {
    assert.equal(isPersonNotFoundError(archiveError(500, NOT_FOUND_BODY)), true)
  })

  test('does NOT match other 500s — an archive failure must not read as a bad fnr', () => {
    // These are all real 500s from azf-archive-v2 that have nothing to do with the number.
    assert.equal(isPersonNotFoundError(archiveError(500, { message: 'Oh no, zipCode has null value, developer has made a mistake' })), false)
    assert.equal(isPersonNotFoundError(archiveError(500, { message: 'Several elevmapper found on social security number: 123' })), false)
    assert.equal(isPersonNotFoundError(archiveError(500, { message: 'AxiosError: connect ECONNREFUSED' })), false)
    assert.equal(isPersonNotFoundError(archiveError(502, { message: 'Bad gateway' })), false)
  })

  test('never throws on odd shapes', () => {
    assert.equal(isPersonNotFoundError(undefined), false)
    assert.equal(isPersonNotFoundError(new Error('boom')), false)
    assert.equal(isPersonNotFoundError(archiveError(500, undefined)), false)
    assert.equal(isPersonNotFoundError(archiveError(500, { message: { nested: true } })), false)
  })
})

describe('syncElevMappe / readElevMappe', () => {
  test('an ordinary elev is synced with forceUpdate true', async () => {
    const { calls, deps } = makeArchive(respondWith(okElevmappe))

    await syncElevMappe('12345678901', true, deps)

    assert.equal(calls[0].endpoint, 'SyncElevmappe')
    assert.deepEqual(calls[0].body, { ssn: '12345678901', forceUpdate: true })
  })

  test('readElevMappe sends forceUpdate false and no manualData', async () => {
    const { calls, deps } = makeArchive(respondWith(okElevmappe))

    const result = await readElevMappe('12345678901', deps)

    assert.deepEqual(calls[0].body, { ssn: '12345678901', forceUpdate: false })
    assert.equal(Object.hasOwn(calls[0].body, 'manualData'), false)
    assert.equal(result.privatePerson.name, 'Ola Nordmann')
  })

  test('an unknown ssn becomes a not-found ArchiveLookupError', async () => {
    const { deps } = makeArchive(failWith(archiveError(500, NOT_FOUND_BODY)))

    await assert.rejects(
      () => readElevMappe('11111111111', deps),
      (error) => {
        assert.ok(error instanceof ArchiveLookupError)
        assert.equal(error.reason, 'not-found')
        return true
      }
    )
  })

  test('any OTHER 500 is an archive failure, not a bad number', async () => {
    const { deps } = makeArchive(failWith(archiveError(500, { message: 'Oh no, zipCode has null value' })))

    await assert.rejects(
      () => readElevMappe('12345678901', deps),
      (error) => {
        assert.equal(error instanceof ArchiveLookupError, false)
        assert.match(error.message, /Kunne ikke nå arkivet/)
        return true
      }
    )
  })

  test('a timeout is an archive failure', async () => {
    const { deps } = makeArchive(failWith(new Error('ETIMEDOUT')))

    await assert.rejects(() => readElevMappe('12345678901', deps), /Kunne ikke nå arkivet/)
  })
})

describe('syncPrivatePerson', () => {
  test('posts ssn and forceUpdate to SyncPrivatePerson', async () => {
    const { calls, deps } = makeArchive(respondWith({ privatePerson: { ssn: '12345678901' } }))

    await syncPrivatePerson('12345678901', true, deps)

    assert.equal(calls[0].endpoint, 'SyncPrivatePerson')
    assert.deepEqual(calls[0].body, { ssn: '12345678901', forceUpdate: true })
  })

  test('an unknown ssn becomes a not-found ArchiveLookupError', async () => {
    const { deps } = makeArchive(failWith(archiveError(500, NOT_FOUND_BODY)))

    await assert.rejects(() => syncPrivatePerson('11111111111', true, deps), (error) => error.reason === 'not-found')
  })
})

describe('syncEnterprise', () => {
  test('posts only { orgnr }', async () => {
    const { calls, deps } = makeArchive(respondWith({ enterprise: { EnterpriseNumber: '929882989' } }))

    const result = await syncEnterprise('929882989', deps)

    assert.equal(calls[0].endpoint, 'SyncEnterprise')
    assert.deepEqual(calls[0].body, { orgnr: '929882989' })
    assert.equal(result.enterprise.EnterpriseNumber, '929882989')
  })

  test('404 means the orgnr does not exist — status IS the discriminator here', async () => {
    // Unlike the person endpoints: getBrregData throws an HTTPError carrying BRREG's status and
    // http-response.js passes it through, so SyncEnterprise really does answer 404.
    const { deps } = makeArchive(failWith(archiveError(404, { message: 'Request failed with status code 404', data: null })))

    await assert.rejects(() => syncEnterprise('999999999', deps), (error) => {
      assert.ok(error instanceof ArchiveLookupError)
      assert.equal(error.reason, 'not-found')
      return true
    })
  })

  test('400 (malformed orgnr) is also not-found rather than a crash', async () => {
    const { deps } = makeArchive(failWith(archiveError(400, { message: { feilmelding: 'Organisasjonsnummer må være et nummer med nøyaktig 9 siffer' } })))

    await assert.rejects(() => syncEnterprise('111', deps), (error) => error.reason === 'not-found')
  })

  test('500 is an archive failure, and must stay distinguishable from 404', async () => {
    const { deps } = makeArchive(failWith(archiveError(500, { message: 'SIF blew up' })))

    await assert.rejects(() => syncEnterprise('929882989', deps), (error) => {
      assert.equal(error instanceof ArchiveLookupError, false)
      assert.match(error.message, /Kunne ikke nå arkivet/)
      return true
    })
  })
})

describe('getCaseNumber', () => {
  test('returns the CaseNumber when present', () => {
    assert.equal(getCaseNumber(okElevmappe, '12345678901'), '23/00077')
  })

  test('a missing CaseNumber is an archive-administrator task, not a TypeError', () => {
    // sync-elevmappe.js's update branch returns whatever UpdateCase gave back, and repackSifResult
    // unwraps a single-property result to a bare recno — so this shape is reachable in production.
    assert.throws(
      () => getCaseNumber({ privatePerson: {}, elevmappe: 211162 }, '12345678901'),
      (error) => {
        assert.ok(error instanceof ArchiveLookupError)
        assert.equal(error.reason, 'no-case-number')
        assert.match(error.message, /arkivansvarlig/)
        return true
      }
    )
  })

  test('handles every absent shape without throwing a TypeError', () => {
    for (const response of [undefined, null, {}, { elevmappe: null }, { elevmappe: {} }, { elevmappe: { Recno: 1 } }]) {
      assert.throws(() => getCaseNumber(response, '12345678901'), (error) => error.reason === 'no-case-number')
    }
  })
})

describe('archiveDocument — which party gets synced, and how', () => {
  const basePayload = {
    fnr: '12345678901',
    schoolOrgNumber: '974568098',
    title: 'Elevavtale',
    attachment: 'base64'
  }

  /**
   * Captures which sync helper was reached, so the routing rules can be asserted directly rather
   * than inferred from the archive payload.
   */
  const makeSyncSpies = (overrides = {}) => {
    const seen = { elevmappe: [], privatePerson: [], enterprise: [], document: null }
    return {
      seen,
      deps: {
        syncElevMappe: async (ssn, forceUpdate) => {
          seen.elevmappe.push({ ssn, forceUpdate })
          return overrides.elevmappe || okElevmappe
        },
        syncPrivatePerson: async (ssn) => {
          seen.privatePerson.push({ ssn })
          return { privatePerson: { ssn } }
        },
        syncEnterprise: async (orgnr) => {
          seen.enterprise.push({ orgnr })
          return { enterprise: { EnterpriseNumber: orgnr, Name: 'TELEMARK FYLKESKOMMUNE' } }
        },
        postDocument: async (payloadToArchive) => {
          seen.document = payloadToArchive
          return { DocumentNumber: '23/00077-60' }
        }
      }
    }
  }

  const contactRole = (document, role) => document.parameter.Contacts.find(c => c.Role === role)

  test('an ordinary elev with a guardian: forceUpdate true, guardian synced as a private person', async () => {
    const { seen, deps } = makeSyncSpies()

    await archiveDocument({ ...basePayload, foresattFnr: '10987654321' }, deps)

    assert.deepEqual(seen.elevmappe, [{ ssn: '12345678901', forceUpdate: true }])
    assert.deepEqual(seen.privatePerson, [{ ssn: '10987654321' }])
    assert.equal(seen.enterprise.length, 0)
    assert.equal(contactRole(seen.document, 'Avsender').ReferenceNumber, '10987654321')
  })

  test('a fiktiv elev is read with forceUpdate FALSE — FREG would have nothing for them', async () => {
    const { seen, deps } = makeSyncSpies()

    await archiveDocument({ ...basePayload, elevFnrType: 'fiktiv', foresattFnr: '10987654321' }, deps)

    assert.deepEqual(seen.elevmappe, [{ ssn: '12345678901', forceUpdate: false }])
  })

  test('an organisation ansvarlig goes to syncEnterprise and NEVER to syncPrivatePerson', async () => {
    const { seen, deps } = makeSyncSpies()

    await archiveDocument({ ...basePayload, ansvarligType: 'organisasjon', foresattFnr: '929882989' }, deps)

    assert.deepEqual(seen.enterprise, [{ orgnr: '929882989' }])
    assert.equal(seen.privatePerson.length, 0, 'an organisation must not be synced as a private person')
    assert.equal(contactRole(seen.document, 'Avsender').ReferenceNumber, '929882989')
  })

  test('the orgnr is read from foresattFnr — the one identifier slot, shared with the person path', async () => {
    // An `|| payload.ansvarligOrgnr` fallback used to live here. Nothing produced it, and its only
    // effect was an unbillable 'Ukjent' contract created without a single error.
    const { seen, deps } = makeSyncSpies()

    await archiveDocument({
      ...basePayload,
      ansvarligType: 'organisasjon',
      foresattFnr: '929882989',
      ansvarligOrgnr: '999999999'
    }, deps)

    assert.deepEqual(seen.enterprise, [{ orgnr: '929882989' }], 'ansvarligOrgnr must be ignored entirely')
  })

  test('an organisation ansvarlig with no foresattFnr fails instead of archiving', async () => {
    const { seen, deps } = makeSyncSpies()
    deps.syncEnterprise = async (orgnr) => {
      seen.enterprise.push({ orgnr })
      if (!orgnr) throw new ArchiveLookupError('not-found', 'Fant ikke organisasjonsnummeret i Enhetsregisteret')
      return { enterprise: { EnterpriseNumber: orgnr } }
    }

    await assert.rejects(
      () => archiveDocument({ ...basePayload, ansvarligType: 'organisasjon', ansvarligOrgnr: '929882989' }, deps),
      (error) => error instanceof ArchiveLookupError && error.reason === 'not-found'
    )
    assert.equal(seen.document, null, 'nothing may be archived for an unresolvable ansvarlig')
  })

  test('the school is always the Mottaker and the elev always Kopi til', async () => {
    const { seen, deps } = makeSyncSpies()

    await archiveDocument({ ...basePayload, ansvarligType: 'organisasjon', foresattFnr: '929882989' }, deps)

    assert.equal(contactRole(seen.document, 'Mottaker').ReferenceNumber, 974568098)
    assert.equal(contactRole(seen.document, 'Kopi til').ReferenceNumber, '12345678901')
    assert.equal(seen.document.parameter.CaseNumber, '23/00077')
  })

  test('an elevmappe with no CaseNumber stops before anything is archived', async () => {
    const { seen, deps } = makeSyncSpies({ elevmappe: { privatePerson: { ssn: '12345678901' }, elevmappe: 211162 } })

    await assert.rejects(
      () => archiveDocument({ ...basePayload, foresattFnr: '10987654321' }, deps),
      (error) => error.reason === 'no-case-number'
    )
    assert.equal(seen.document, null, 'no document may be archived without a saksnummer')
    assert.equal(seen.privatePerson.length, 0, 'and no further syncing should have happened')
  })

  test('an unknown school fails before any archive call is made', async () => {
    const { seen, deps } = makeSyncSpies()

    await assert.rejects(
      () => archiveDocument({ ...basePayload, schoolOrgNumber: '123456789' }, deps),
      (error) => error.reason === 'unknown-school'
    )
    assert.equal(seen.elevmappe.length, 0)
    assert.equal(seen.document, null)
  })
})

describe('findSchool', () => {
  test('resolves a school despite orgNr being a Number and the payload a String', () => {
    const school = findSchool('974568098')
    assert.equal(school.officeLocation, 'Bamble videregående skole')
    assert.ok(school.tilgangsgruppe)
  })

  test('accepts a Number too', () => {
    assert.equal(findSchool(974568098).officeLocation, 'Bamble videregående skole')
  })

  test('an unknown school fails with a named error instead of dereferencing undefined', () => {
    assert.throws(() => findSchool('123456789'), (error) => {
      assert.ok(error instanceof ArchiveLookupError)
      assert.equal(error.reason, 'unknown-school')
      return true
    })
    assert.throws(() => findSchool(undefined), (error) => error.reason === 'unknown-school')
    assert.throws(() => findSchool(''), (error) => error.reason === 'unknown-school')
  })
})
