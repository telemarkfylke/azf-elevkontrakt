'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  detectIdentifierType,
  isValidOrgnrChecksum,
  isValidFnrChecksum,
  getAnsvarligType,
  isOrganisation,
  getElevFnrType,
  isFiktivElev,
  normalizeIdentifier
} = require('../identifier.js')

describe('detectIdentifierType', () => {
  test('11 digits is a fnr, 9 digits is an orgnr', () => {
    assert.equal(detectIdentifierType('12345678901'), 'fnr')
    assert.equal(detectIdentifierType('929882989'), 'orgnr')
  })

  test('a fiktivt fnr that fails mod-11 is still detected as a fnr', () => {
    // The whole point: length decides person-vs-organisation, FREG decides real-vs-fiktiv.
    // Rejecting a mod-11 failure here would block the fiktiv-fnr feature outright.
    assert.equal(detectIdentifierType('11111111111'), 'fnr')
    assert.equal(detectIdentifierType('99999999999'), 'fnr')
  })

  test('any other length is not an identifier', () => {
    assert.equal(detectIdentifierType('1234567890'), null) // 10
    assert.equal(detectIdentifierType('123456789012'), null) // 12
    assert.equal(detectIdentifierType('12345678'), null) // 8
    assert.equal(detectIdentifierType(''), null)
  })

  test('non-digits are rejected', () => {
    assert.equal(detectIdentifierType('1234567890a'), null)
    assert.equal(detectIdentifierType('abcdefghijk'), null)
    assert.equal(detectIdentifierType(undefined), null)
    assert.equal(detectIdentifierType(null), null)
    assert.equal(detectIdentifierType({}), null)
  })

  test('pasted formatting is stripped before the length check', () => {
    assert.equal(detectIdentifierType('123456 78901'), 'fnr')
    assert.equal(detectIdentifierType('929 882 989'), 'orgnr')
    assert.equal(detectIdentifierType('929.882.989'), 'orgnr')
    assert.equal(detectIdentifierType(' 929882989 '), 'orgnr')
  })
})

describe('normalizeIdentifier', () => {
  test('keeps digits, drops separators', () => {
    assert.equal(normalizeIdentifier(' 929 882.989 '), '929882989')
    assert.equal(normalizeIdentifier(929882989), '929882989')
    assert.equal(normalizeIdentifier(undefined), '')
    assert.equal(normalizeIdentifier(null), '')
  })
})

describe('isValidOrgnrChecksum', () => {
  test('accepts real organisasjonsnummer', () => {
    assert.equal(isValidOrgnrChecksum('929882989'), true) // Telemark fylkeskommune
    assert.equal(isValidOrgnrChecksum('974568098'), true) // from tfk-schools.js
    assert.equal(isValidOrgnrChecksum('973754815'), true) // from tfk-schools.js
  })

  test('rejects a wrong control digit', () => {
    assert.equal(isValidOrgnrChecksum('929882988'), false)
    assert.equal(isValidOrgnrChecksum('929882987'), false)
  })

  test('rejects a number whose control digit would have to be 10', () => {
    // remainder === 1 => control digit 11 - 1 === 10, which is not expressible in one digit
    assert.equal(isValidOrgnrChecksum('123456780'), false)
    assert.equal(isValidOrgnrChecksum('123456789'), false)
  })

  test('rejects anything that is not exactly 9 digits', () => {
    assert.equal(isValidOrgnrChecksum('92988298'), false)
    assert.equal(isValidOrgnrChecksum('9298829893'), false)
    assert.equal(isValidOrgnrChecksum('12345678901'), false)
    assert.equal(isValidOrgnrChecksum(''), false)
    assert.equal(isValidOrgnrChecksum(undefined), false)
    assert.equal(isValidOrgnrChecksum(null), false)
  })

  test('accepts formatted input', () => {
    assert.equal(isValidOrgnrChecksum('929 882 989'), true)
  })
})

describe('getAnsvarligType / isOrganisation — legacy documents must keep working', () => {
  test('an explicit organisasjon reads as organisasjon', () => {
    assert.equal(getAnsvarligType({ type: 'organisasjon' }), 'organisasjon')
    assert.equal(isOrganisation({ type: 'organisasjon' }), true)
  })

  test('an explicit person reads as person', () => {
    assert.equal(getAnsvarligType({ type: 'person' }), 'person')
    assert.equal(isOrganisation({ type: 'person' }), false)
  })

  test('a legacy ansvarligInfo with no type field reads as person', () => {
    // Every contract written before this feature, plus every un-backfilled invoice.recipient.
    assert.equal(getAnsvarligType({ navn: 'Ola Nordmann', fnr: '12345678901' }), 'person')
    assert.equal(isOrganisation({ navn: 'Ola Nordmann', fnr: '12345678901' }), false)
  })

  test('an empty or missing ansvarligInfo reads as person and never throws', () => {
    assert.equal(getAnsvarligType({}), 'person')
    assert.equal(getAnsvarligType(undefined), 'person')
    assert.equal(getAnsvarligType(null), 'person')
    assert.equal(isOrganisation(undefined), false)
  })

  test('an unrecognised type reads as person rather than being trusted', () => {
    assert.equal(getAnsvarligType({ type: 'Organisasjon' }), 'person')
    assert.equal(getAnsvarligType({ type: 'firma' }), 'person')
    assert.equal(getAnsvarligType({ type: true }), 'person')
  })
})

describe('getElevFnrType / isFiktivElev — legacy documents must keep working', () => {
  test('an explicit fiktiv reads as fiktiv', () => {
    assert.equal(getElevFnrType({ fnrType: 'fiktiv' }), 'fiktiv')
    assert.equal(isFiktivElev({ fnrType: 'fiktiv' }), true)
  })

  test('a legacy elevInfo with no fnrType reads as ordinær', () => {
    assert.equal(getElevFnrType({ navn: 'Ola Nordmann', fnr: '12345678901' }), 'ordinær')
    assert.equal(isFiktivElev({ navn: 'Ola Nordmann', fnr: '12345678901' }), false)
  })

  test('an empty or missing elevInfo reads as ordinær and never throws', () => {
    assert.equal(getElevFnrType({}), 'ordinær')
    assert.equal(getElevFnrType(undefined), 'ordinær')
    assert.equal(getElevFnrType(null), 'ordinær')
    assert.equal(isFiktivElev(undefined), false)
  })

  test('an unrecognised fnrType reads as ordinær', () => {
    assert.equal(getElevFnrType({ fnrType: 'Fiktiv' }), 'ordinær')
    assert.equal(getElevFnrType({ fnrType: true }), 'ordinær')
  })
})

describe('isValidFnrChecksum', () => {
  test('accepts a valid fødselsnummer and D-nummer', () => {
    assert.equal(isValidFnrChecksum('01019000083'), true)
    assert.equal(isValidFnrChecksum('41019000077'), true) // D-nummer
    assert.equal(isValidFnrChecksum('010190 000 83'), true)
  })

  test('rejects a wrong first or second control digit', () => {
    assert.equal(isValidFnrChecksum('01019000093'), false)
    assert.equal(isValidFnrChecksum('01019000084'), false)
  })

  test('rejects anything that is not exactly 11 digits', () => {
    assert.equal(isValidFnrChecksum('0101900008'), false)
    assert.equal(isValidFnrChecksum('929882989'), false)
    assert.equal(isValidFnrChecksum('Ukjent'), false)
    assert.equal(isValidFnrChecksum(undefined), false)
  })
})
