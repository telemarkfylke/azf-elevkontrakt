'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { getSchoolyear } = require('../getSchoolyear')

// =====================================================================
// getSchoolyear — reads the system clock directly with no injectable seam,
// so these tests assert structural invariants that hold on any date rather
// than a fixed expected value.
//
// Coverage note: the `month < 6` branch is only reachable January-June and
// the other branch only July-December, so exactly one of the two is covered
// on any given run. Full branch coverage is not reachable without adding a
// clock parameter to the production function.
// =====================================================================

describe('getSchoolyear', () => {
  test('returns two four-digit years joined by a hyphen', () => {
    assert.match(getSchoolyear(), /^\d{4}-\d{4}$/)
  })

  test('the second year is exactly one after the first', () => {
    const [start, end] = getSchoolyear().split('-').map(Number)

    assert.equal(end, start + 1)
  })

  test('the current calendar year is one of the two years in the range', () => {
    const currentYear = new Date().getFullYear()
    const [start, end] = getSchoolyear().split('-').map(Number)

    assert.ok(start === currentYear || end === currentYear, `expected ${currentYear} in ${start}-${end}`)
  })

  test('agrees with the documented cutover: July onwards starts the new school year', () => {
    const date = new Date()
    const year = date.getFullYear()
    const expected = date.getMonth() < 6 ? `${year - 1}-${year}` : `${year}-${year + 1}`

    assert.equal(getSchoolyear(), expected)
  })

  test('is stable across repeated calls', () => {
    assert.equal(getSchoolyear(), getSchoolyear())
  })

  test('returns a string, not a number or Date', () => {
    assert.equal(typeof getSchoolyear(), 'string')
  })
})
