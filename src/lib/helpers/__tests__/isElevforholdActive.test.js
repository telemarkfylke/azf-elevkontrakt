'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { isElevforholdActive } = require('../isElevforholdActive')
const { getSchoolyear } = require('../getSchoolyear')

// ---- Helpers ---------------------------------------------------------------

const currentSchoolYearStart = Number(getSchoolyear().split('-')[0])
const currentSchoolYearStartISO = new Date(Date.UTC(currentSchoolYearStart, 7, 1)).toISOString()
const currentSchoolYearEndISO = new Date(Date.UTC(currentSchoolYearStart + 1, 6, 31, 23, 59, 59, 999)).toISOString()
const DAY_MS = 24 * 60 * 60 * 1000

const makeForhold = (overrides = {}) => ({
  aktiv: false,
  avbruddsdato: null,
  gyldighetsperiode: {
    start: currentSchoolYearStartISO,
    slutt: currentSchoolYearEndISO
  },
  ...overrides
})

// =====================================================================

describe('isElevforholdActive', () => {
  test('returns true when gyldighetsperiode overlaps the current school year, regardless of aktiv', () => {
    const forhold = makeForhold({ aktiv: false })
    assert.equal(isElevforholdActive(forhold), true)
  })

  test('returns false when gyldighetsperiode ended before the current school year', () => {
    const forhold = makeForhold({
      gyldighetsperiode: { start: '2000-08-01T00:00:00.000Z', slutt: '2001-07-31T23:59:59.999Z' }
    })
    assert.equal(isElevforholdActive(forhold), false)
  })

  test('returns false when gyldighetsperiode starts after the current school year', () => {
    const forhold = makeForhold({
      gyldighetsperiode: { start: '3000-08-01T00:00:00.000Z', slutt: '3001-07-31T23:59:59.999Z' }
    })
    assert.equal(isElevforholdActive(forhold), false)
  })

  test('returns false when avbruddsdato is in the past, even if gyldighetsperiode overlaps', () => {
    const forhold = makeForhold({ avbruddsdato: '2000-01-01T00:00:00.000Z' })
    assert.equal(isElevforholdActive(forhold), false)
  })

  test('returns true when avbruddsdato is in the future', () => {
    const forhold = makeForhold({ avbruddsdato: '3000-01-01T00:00:00.000Z' })
    assert.equal(isElevforholdActive(forhold), true)
  })

  test('returns false when gyldighetsperiode is missing', () => {
    assert.equal(isElevforholdActive({ aktiv: true }), false)
  })

  test('returns false when gyldighetsperiode ended yesterday, even though it overlaps the current school year', () => {
    const yesterday = new Date(Date.now() - DAY_MS).toISOString()
    const forhold = makeForhold({
      gyldighetsperiode: { start: currentSchoolYearStartISO, slutt: yesterday }
    })
    assert.equal(isElevforholdActive(forhold), false)
  })

  // In July getSchoolyear() has already flipped, so a period ending today falls before the window.
  test('returns true when gyldighetsperiode ends later today', { skip: Date.now() < Date.parse(currentSchoolYearStartISO) }, () => {
    const endOfToday = `${new Date().toISOString().substring(0, 11)}23:59:59.999Z`
    const forhold = makeForhold({
      gyldighetsperiode: { start: currentSchoolYearStartISO, slutt: endOfToday }
    })
    assert.equal(isElevforholdActive(forhold), true)
  })

  test('returns true when gyldighetsperiode starts in the future but within the current school year', () => {
    const forhold = makeForhold({
      gyldighetsperiode: { start: new Date(Date.parse(currentSchoolYearEndISO) - 30 * DAY_MS).toISOString(), slutt: currentSchoolYearEndISO }
    })
    assert.equal(isElevforholdActive(forhold), true)
  })

  test('returns true when slutt is null (open-ended) and start has passed', () => {
    const forhold = makeForhold({
      gyldighetsperiode: { start: '2000-08-01T00:00:00.000Z', slutt: null }
    })
    assert.equal(isElevforholdActive(forhold), true)
  })

  test('returns false when start is missing', () => {
    const forhold = makeForhold({
      gyldighetsperiode: { start: null, slutt: currentSchoolYearEndISO }
    })
    assert.equal(isElevforholdActive(forhold), false)
  })
})
