'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { fillManualDocument } = require('../../documentSchema.js')

const makeContract = (overrides = {}) => ({
  fnr: '12345678901',
  foresattFnr: '01019012345',
  type: 'Leieavtale',
  schoolOrgNumber: '974568098',
  ...overrides
})

const makeArchiveData = (overrides = {}) => ({
  DocumentNumber: '23/00077-60',
  ...overrides
})

const makeAnsvarligData = (overrides = {}) => ({
  fulltnavn: 'Kari Nordmann',
  foedselsEllerDNummer: '01019012345',
  ...overrides
})

describe('fillManualDocument', () => {
  test('defaults document.error to an empty array when no error param is passed', () => {
    const document = fillManualDocument(makeContract(), makeArchiveData(), undefined, makeAnsvarligData())
    assert.deepEqual(document.error, [])
  })

  test('carries the provided error array through to document.error', () => {
    const error = [{ error: 'Ansvarlig ikke funnet i FREG', fnr: '01019012345' }]
    const document = fillManualDocument(makeContract(), makeArchiveData(), undefined, undefined, error)
    assert.deepEqual(document.error, error)
  })

  test('signedBy falls back to Ukjent when ansvarligData could not be resolved', () => {
    const error = [{ error: 'Ansvarlig ikke funnet i FREG', fnr: '01019012345' }]
    const document = fillManualDocument(makeContract(), makeArchiveData(), undefined, undefined, error)
    assert.deepEqual(document.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('signedBy is populated correctly when ansvarligData resolves normally', () => {
    const document = fillManualDocument(makeContract(), makeArchiveData(), undefined, makeAnsvarligData())
    assert.deepEqual(document.signedBy, { navn: 'Kari Nordmann', fnr: '01019012345' })
    assert.deepEqual(document.error, [])
  })
})
