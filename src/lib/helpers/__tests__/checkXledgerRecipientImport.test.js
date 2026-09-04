'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { isRecipientImportedToXledger } = require('../checkXledgerRecipientImport.js')

describe('isRecipientImportedToXledger', () => {
  test('boolean true is imported', () => {
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: true }), true)
  })

  test('the string "true" is imported (documentSchema writes the flag as a string)', () => {
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 'true' }), true)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 'True' }), true)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 'TRUE' }), true)
  })

  test('the string "false" is NOT imported, even though the string is truthy', () => {
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 'false' }), false)
  })

  test('boolean false is not imported', () => {
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: false }), false)
  })

  test('a missing field is not imported', () => {
    assert.equal(isRecipientImportedToXledger({}), false)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: undefined }), false)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: null }), false)
  })

  test('a missing contract is not imported (never throws)', () => {
    assert.equal(isRecipientImportedToXledger(undefined), false)
    assert.equal(isRecipientImportedToXledger(null), false)
  })

  test('other truthy values are not accepted as imported', () => {
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 1 }), false)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: 'yes' }), false)
    assert.equal(isRecipientImportedToXledger({ isImportedToXledger: {} }), false)
  })
})
