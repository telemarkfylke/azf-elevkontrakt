'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { isRecipientImportedToXledger, hasRecipientSettledInXledger, XLEDGER_SETTLE_DAYS } = require('../checkXledgerRecipientImport.js')

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-30T00:30:00.000Z').getTime()

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

describe('hasRecipientSettledInXledger', () => {
  test('the settle period is 7 days', () => {
    assert.equal(XLEDGER_SETTLE_DAYS, 7)
  })

  test('settled once the import is at least 7 days old', () => {
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW - 7 * DAY) }, NOW), true)
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW - 30 * DAY) }, NOW), true)
  })

  test('not settled while the import is younger than 7 days', () => {
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW - 7 * DAY + 1) }, NOW), false)
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW) }, NOW), false)
  })

  test('an ISO date string counts the same as a Date (a document can come back either way)', () => {
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW - 8 * DAY).toISOString() }, NOW), true)
  })

  test('"Ukjent" (written by xledgerResetUserImportStatus) is not settled', () => {
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: 'Ukjent' }, NOW), false)
  })

  test('a missing field, an unparseable string, a number and a missing contract are not settled (never throws)', () => {
    for (const contract of [{}, { importedToXledgerAt: null }, { importedToXledgerAt: 'ikke en dato' }, { importedToXledgerAt: NOW - 30 * DAY }, null, undefined]) {
      assert.equal(hasRecipientSettledInXledger(contract, NOW), false, `${JSON.stringify(contract)} should not count as settled`)
    }
  })

  test('the period can be overridden', () => {
    assert.equal(hasRecipientSettledInXledger({ importedToXledgerAt: new Date(NOW - 2 * DAY) }, NOW, 1), true)
  })
})
