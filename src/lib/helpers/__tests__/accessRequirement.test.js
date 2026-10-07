'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { isSchool, checkAccessRequirement } = require('../accessRequirement')

const SCHOOL = { requirement: 'school' }
const DIGITAL = { requirement: 'digital' }
const NONE = { requirement: 'none' }

describe('isSchool', () => {
  test('matches officeLocation and primaryLocation from tfk-schools', () => {
    assert.equal(isSchool('Bø vidaregåande skule'), true)
    assert.equal(isSchool('Bø videregående skole'), true)
  })

  test('ignores case and surrounding spaces', () => {
    assert.equal(isSchool('  skien videregående skole '), true)
  })

  test("counts Nome's departments as Nome", () => {
    assert.equal(isSchool('Nome videregående skole avd Søve'), true)
  })

  test('is false for non-schools and empty values', () => {
    assert.equal(isSchool('Telemark fylkeskommune'), false)
    assert.equal(isSchool(''), false)
    assert.equal(isSchool(null), false)
  })
})

describe('checkAccessRequirement', () => {
  test('school role: ok when companyName is a school', () => {
    assert.deepEqual(checkAccessRequirement({ companyName: 'Bamble videregående skole' }, SCHOOL), { ok: true })
  })

  test('school role: ok when only department is a school', () => {
    assert.equal(checkAccessRequirement({ companyName: 'Telemark fylkeskommune', department: 'Porsgrunn videregående skole' }, SCHOOL).ok, true)
  })

  test('school role: not ok outside a school', () => {
    const result = checkAccessRequirement({ companyName: 'Telemark fylkeskommune', department: 'Økonomi' }, SCHOOL)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-at-school')
  })

  test('school role: not ok when both fields are missing', () => {
    assert.equal(checkAccessRequirement({}, SCHOOL).ok, false)
  })

  test('IT-servicedesk: ok for Digitale tjenester', () => {
    assert.equal(checkAccessRequirement({ companyName: 'Digitale tjenester' }, DIGITAL).ok, true)
  })

  test('IT-servicedesk: not ok for anyone else, even at a school', () => {
    const result = checkAccessRequirement({ companyName: 'Skien videregående skole', department: 'Digitale tjenester' }, DIGITAL)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-digital')
  })

  test('administrator: no requirement', () => {
    assert.equal(checkAccessRequirement({}, NONE).ok, true)
  })
})
