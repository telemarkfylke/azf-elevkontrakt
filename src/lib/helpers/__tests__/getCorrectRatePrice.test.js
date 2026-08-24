'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { returnCorrectPriceForStudent } = require('../getCorrectRatePrice')

// ---- Helpers ---------------------------------------------------------------

const makePrices = (overrides = {}) => ({
  regularPrice: '1500',
  reducedPrice: '0',
  ...overrides
})

const makeExceptions = (overrides = {}) => ({
  students: [],
  classes: [],
  ...overrides
})

// =====================================================================
// returnCorrectPriceForStudent — decides what a single student is charged
// per rate, so a wrong answer here bills the wrong amount.
// =====================================================================

describe('returnCorrectPriceForStudent', () => {
  test('returns the regular price when there are no exceptions at all', () => {
    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), makeExceptions())

    assert.equal(price, '1500')
  })

  test('returns the reduced price when the student fnr is in the student exceptions', () => {
    const exceptions = makeExceptions({ students: [{ fnr: '12345678901' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '0')
  })

  test('returns the reduced price when the class is in the class exceptions', () => {
    const exceptions = makeExceptions({ classes: [{ className: '1STA' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '0')
  })

  test('returns the regular price when the student exceptions list is non-empty but does not match', () => {
    const exceptions = makeExceptions({ students: [{ fnr: '99999999999' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '1500')
  })

  test('returns the regular price when the class exceptions list is non-empty but does not match', () => {
    const exceptions = makeExceptions({ classes: [{ className: '2STB' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '1500')
  })

  test('returns the regular price when neither the student nor the class matches, with both lists populated', () => {
    const exceptions = makeExceptions({
      students: [{ fnr: '99999999999' }],
      classes: [{ className: '2STB' }]
    })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '1500')
  })

  test('a student exception applies even when the class exceptions list is populated and does not match', () => {
    const exceptions = makeExceptions({
      students: [{ fnr: '12345678901' }],
      classes: [{ className: '2STB' }]
    })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '0')
  })

  test('a matching class still gives the reduced price when the student list is populated but does not match', () => {
    const exceptions = makeExceptions({
      students: [{ fnr: '99999999999' }],
      classes: [{ className: '1STA' }]
    })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '0')
  })

  test('matching is exact — a partial fnr does not count as a student exception', () => {
    const exceptions = makeExceptions({ students: [{ fnr: '1234567890' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '1500')
  })

  test('class matching is case sensitive — a differently cased class name does not match', () => {
    const exceptions = makeExceptions({ classes: [{ className: '1sta' }] })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '1500')
  })

  test('finds the student anywhere in a longer exceptions list, not just at the head', () => {
    const exceptions = makeExceptions({
      students: [{ fnr: '11111111111' }, { fnr: '22222222222' }, { fnr: '12345678901' }]
    })

    const price = returnCorrectPriceForStudent('12345678901', '1STA', makePrices(), exceptions)

    assert.equal(price, '0')
  })
})
