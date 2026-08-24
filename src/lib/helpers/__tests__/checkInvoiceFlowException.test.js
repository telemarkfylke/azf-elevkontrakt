'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { hasInvoiceFlowException } = require('../checkInvoiceFlowException')

// ---- Helpers ---------------------------------------------------------------

const makeExceptions = (students = []) => ({ students })

// =====================================================================
// hasInvoiceFlowException — decides whether a student is lifted out of the
// normal invoice flow, so a false positive silently stops billing.
// =====================================================================

describe('hasInvoiceFlowException', () => {
  test('returns true when the fnr is in the exceptions list', () => {
    const exceptions = makeExceptions([{ fnr: '12345678901' }])

    assert.equal(hasInvoiceFlowException('12345678901', exceptions), true)
  })

  test('returns false when the fnr is not in the exceptions list', () => {
    const exceptions = makeExceptions([{ fnr: '99999999999' }])

    assert.equal(hasInvoiceFlowException('12345678901', exceptions), false)
  })

  test('returns false when the exceptions list is empty', () => {
    assert.equal(hasInvoiceFlowException('12345678901', makeExceptions()), false)
  })

  test('finds the fnr anywhere in the list, not just at the head', () => {
    const exceptions = makeExceptions([{ fnr: '11111111111' }, { fnr: '22222222222' }, { fnr: '12345678901' }])

    assert.equal(hasInvoiceFlowException('12345678901', exceptions), true)
  })

  test('returns a real boolean rather than the matched entry object', () => {
    const exceptions = makeExceptions([{ fnr: '12345678901', reason: 'Betaler utenfor systemet' }])

    const result = hasInvoiceFlowException('12345678901', exceptions)

    assert.equal(typeof result, 'boolean')
    assert.equal(result, true)
  })

  test('matching is exact — a partial fnr is not an exception', () => {
    const exceptions = makeExceptions([{ fnr: '1234567890' }])

    assert.equal(hasInvoiceFlowException('12345678901', exceptions), false)
  })

  test('ignores other properties on the entry and matches on fnr only', () => {
    const exceptions = makeExceptions([{ fnr: '12345678901', navn: 'Test Elev', klasse: '1STA' }])

    assert.equal(hasInvoiceFlowException('12345678901', exceptions), true)
  })
})
