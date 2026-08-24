'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const mappers = require('../mappers')
const kontrakterMapper = require('../mappers/kontrakter')
const historiskePcIkkeInnlevertMapper = require('../mappers/historiskePcIkkeInnlevert')

// ---- Helpers ---------------------------------------------------------------

const makeDoc = (overrides = {}) => ({
  _id: 'doc-id-1',
  pureserviceId: 4321,
  fakturaInfo: {
    rate1: { status: 'Betalt' },
    rate2: { status: 'Ikke Fakturert' },
    rate3: { status: 'Ikke Fakturert' }
  },
  ...overrides
})

const makeUpdateEvent = (updatedFields) => ({
  operationType: 'update',
  ns: { coll: 'kontrakter' },
  updateDescription: { updatedFields }
})

// The two mappers are near-identical by design. Running one table over both means a future
// divergence shows up as a failure rather than being silently introduced in only one of them.
const allMappers = [
  ['kontrakter', kontrakterMapper],
  ['historiskePcIkkeInnlevert', historiskePcIkkeInnlevertMapper]
]

// =====================================================================
// Mapper registry — the collection names here must match
// CHANGE_STREAM_WATCH_COLLECTIONS, or forwardChange throws at runtime.
// =====================================================================

describe('mappers registry', () => {
  test('registers a mapper for the kontrakter collection', () => {
    assert.equal(typeof mappers.kontrakter, 'function')
  })

  test('registers a mapper for the historiske-avtaler-pc-ikke-innlevert collection', () => {
    assert.equal(typeof mappers['historiske-avtaler-pc-ikke-innlevert'], 'function')
  })

  test('exposes exactly the two known collections', () => {
    assert.deepEqual(Object.keys(mappers).sort(), ['historiske-avtaler-pc-ikke-innlevert', 'kontrakter'])
  })

  test('the registry entries are the same functions as the mapper modules', () => {
    assert.equal(mappers.kontrakter, kontrakterMapper)
    assert.equal(mappers['historiske-avtaler-pc-ikke-innlevert'], historiskePcIkkeInnlevertMapper)
  })
})

// =====================================================================
// Skip and forward decisions — a wrong skip drops a Pureservice update
// silently, since forwardChange treats { skip } as success.
// =====================================================================

for (const [name, mapper] of allMappers) {
  describe(`${name} mapper - skip decisions`, () => {
    test('skips when pureserviceId is not set', () => {
      const result = mapper(makeDoc({ pureserviceId: undefined }))

      assert.deepEqual(result, { skip: 'pureserviceId not set' })
    })

    test('skips when pureserviceId is null', () => {
      assert.deepEqual(mapper(makeDoc({ pureserviceId: null })), { skip: 'pureserviceId not set' })
    })

    test('skips when pureserviceId is 0, since it is falsy', () => {
      assert.deepEqual(mapper(makeDoc({ pureserviceId: 0 })), { skip: 'pureserviceId not set' })
    })

    test('the pureserviceId check runs before the changed-fields check', () => {
      const event = makeUpdateEvent({ 'fakturaInfo.rate1.status': 'Betalt' })

      assert.deepEqual(mapper(makeDoc({ pureserviceId: undefined }), event), { skip: 'pureserviceId not set' })
    })

    test('forwards when a fakturaInfo subfield was updated', () => {
      const result = mapper(makeDoc(), makeUpdateEvent({ 'fakturaInfo.rate1.status': 'Betalt' }))

      assert.equal(result.skip, undefined)
      assert.equal(result.pusId, 4321)
    })

    test('forwards when the whole fakturaInfo object was replaced', () => {
      const result = mapper(makeDoc(), makeUpdateEvent({ fakturaInfo: {} }))

      assert.equal(result.skip, undefined)
    })

    test('forwards when pureserviceId itself was updated', () => {
      const result = mapper(makeDoc(), makeUpdateEvent({ pureserviceId: 4321 }))

      assert.equal(result.skip, undefined)
    })

    test('skips when only an unrelated field was updated', () => {
      const result = mapper(makeDoc(), makeUpdateEvent({ 'elevInfo.klasse': '2STB' }))

      assert.deepEqual(result, { skip: 'no fakturaInfo or pureserviceId field changed' })
    })

    test('forwards when a relevant field is updated alongside irrelevant ones', () => {
      const event = makeUpdateEvent({ 'elevInfo.klasse': '2STB', 'fakturaInfo.rate2.status': 'Betalt' })

      assert.equal(mapper(makeDoc(), event).skip, undefined)
    })

    test('skips a change event that carries no updateDescription (current behaviour for inserts)', () => {
      // The doc comment says insertions always forward, but an insert event has no
      // updateDescription, so the updatedFields check finds nothing and skips.
      const insertEvent = { operationType: 'insert', ns: { coll: 'kontrakter' } }

      assert.deepEqual(mapper(makeDoc(), insertEvent), { skip: 'no fakturaInfo or pureserviceId field changed' })
    })

    test('skips when updatedFields is empty', () => {
      assert.deepEqual(mapper(makeDoc(), makeUpdateEvent({})), { skip: 'no fakturaInfo or pureserviceId field changed' })
    })

    test('forwards unconditionally when no change event is given (the full sync path)', () => {
      const result = mapper(makeDoc())

      assert.equal(result.skip, undefined)
      assert.equal(result.pusId, 4321)
    })

    test('the prefix match is anchored — a field merely containing fakturaInfo does not count', () => {
      const event = makeUpdateEvent({ 'elevInfo.fakturaInfoKopi': 'x' })

      assert.deepEqual(mapper(makeDoc(), event), { skip: 'no fakturaInfo or pureserviceId field changed' })
    })
  })

  // =====================================================================
  // cf_2 payload — Pureservice receives this as a JSON string, so it has to
  // parse and carry all three rate statuses.
  // =====================================================================

  describe(`${name} mapper - cf_2 payload`, () => {
    test('returns the pureserviceId as pusId and a patch containing only cf_2', () => {
      const result = mapper(makeDoc())

      assert.equal(result.pusId, 4321)
      assert.deepEqual(Object.keys(result.patch), ['cf_2'])
    })

    test('cf_2 is a string that parses as JSON', () => {
      const result = mapper(makeDoc())

      assert.equal(typeof result.patch.cf_2, 'string')
      assert.doesNotThrow(() => JSON.parse(result.patch.cf_2))
    })

    test('cf_2 carries the document id and all three rate statuses', () => {
      const result = mapper(makeDoc())

      assert.deepEqual(JSON.parse(result.patch.cf_2), {
        _id: 'doc-id-1',
        rate1: 'Betalt',
        rate2: 'Ikke Fakturert',
        rate3: 'Ikke Fakturert'
      })
    })

    test('missing fakturaInfo yields empty strings rather than the string "undefined"', () => {
      const result = mapper(makeDoc({ fakturaInfo: undefined }))

      assert.deepEqual(JSON.parse(result.patch.cf_2), { _id: 'doc-id-1', rate1: '', rate2: '', rate3: '' })
    })

    test('a partially populated fakturaInfo yields empty strings for the missing rates', () => {
      const result = mapper(makeDoc({ fakturaInfo: { rate1: { status: 'Betalt' } } }))

      assert.deepEqual(JSON.parse(result.patch.cf_2), { _id: 'doc-id-1', rate1: 'Betalt', rate2: '', rate3: '' })
    })

    test('a missing _id yields an empty string', () => {
      const result = mapper(makeDoc({ _id: undefined }))

      assert.equal(JSON.parse(result.patch.cf_2)._id, '')
    })

    test('stringifies a non-string _id, such as an ObjectId', () => {
      const objectIdLike = { toString: () => '507f1f77bcf86cd799439011' }

      const result = mapper(makeDoc({ _id: objectIdLike }))

      assert.equal(JSON.parse(result.patch.cf_2)._id, '507f1f77bcf86cd799439011')
    })

    test('carries the Norwegian status values through unchanged', () => {
      const doc = makeDoc({
        fakturaInfo: {
          rate1: { status: 'Utlån faktureres ikke' },
          rate2: { status: 'Fakturert - Utkjøp' },
          rate3: { status: 'Overført inkasso' }
        }
      })

      const parsed = JSON.parse(mapper(doc).patch.cf_2)

      assert.equal(parsed.rate1, 'Utlån faktureres ikke')
      assert.equal(parsed.rate2, 'Fakturert - Utkjøp')
      assert.equal(parsed.rate3, 'Overført inkasso')
    })
  })
}

// =====================================================================
// The two mappers are expected to agree for now — this pins that so any
// intentional divergence has to be made deliberately.
// =====================================================================

describe('mapper parity', () => {
  test('both mappers produce identical output for the same document', () => {
    const doc = makeDoc()

    assert.deepEqual(kontrakterMapper(doc), historiskePcIkkeInnlevertMapper(doc))
  })

  test('both mappers skip identically', () => {
    const doc = makeDoc({ pureserviceId: undefined })

    assert.deepEqual(kontrakterMapper(doc), historiskePcIkkeInnlevertMapper(doc))
  })
})
