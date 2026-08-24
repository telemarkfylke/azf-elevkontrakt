'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { norwegianDateToISO } = require('../digiTrollDateToISOString')

// =====================================================================
// norwegianDateToISO — converts the dd.MM.yyyy dates that come out of
// Digitroll into ISO strings. The Date.UTC call is the important part:
// parsing as local time would shift the date by a day for anyone running
// east of UTC, which is exactly where these imports run.
// =====================================================================

describe('norwegianDateToISO', () => {
  test('converts a valid dd.MM.yyyy date to an ISO string at UTC midnight', () => {
    assert.equal(norwegianDateToISO('10.08.2022'), '2022-08-10T00:00:00.000Z')
  })

  test('always lands on UTC midnight, never shifted by the local timezone', () => {
    const iso = norwegianDateToISO('01.01.2023')

    assert.ok(iso.endsWith('T00:00:00.000Z'), 'time component must be UTC midnight')
    assert.equal(iso, '2023-01-01T00:00:00.000Z')
  })

  test('keeps the day of month intact for a date that would roll backwards in a positive-offset timezone', () => {
    // Norway is UTC+1/+2. Parsing "31.12.2022" as local time would produce 2022-12-30T23:00:00Z.
    assert.equal(norwegianDateToISO('31.12.2022'), '2022-12-31T00:00:00.000Z')
  })

  test('handles a leap day', () => {
    assert.equal(norwegianDateToISO('29.02.2024'), '2024-02-29T00:00:00.000Z')
  })

  test('handles the first and last day of a year', () => {
    assert.equal(norwegianDateToISO('01.01.2020'), '2020-01-01T00:00:00.000Z')
    assert.equal(norwegianDateToISO('31.12.2020'), '2020-12-31T00:00:00.000Z')
  })

  test('requires zero-padded two-digit day and month', () => {
    assert.throws(() => norwegianDateToISO('1.8.2022'), /Bad format dd\.MM\.yyyy/)
    assert.throws(() => norwegianDateToISO('01.8.2022'), /Bad format dd\.MM\.yyyy/)
    assert.throws(() => norwegianDateToISO('1.08.2022'), /Bad format dd\.MM\.yyyy/)
  })

  test('rejects an ISO-formatted date', () => {
    assert.throws(() => norwegianDateToISO('2022-08-10'), /Bad format dd\.MM\.yyyy/)
  })

  test('rejects a two-digit year', () => {
    assert.throws(() => norwegianDateToISO('10.08.22'), /Bad format dd\.MM\.yyyy/)
  })

  test('rejects an empty string, undefined and null', () => {
    assert.throws(() => norwegianDateToISO(''), /Bad format dd\.MM\.yyyy/)
    assert.throws(() => norwegianDateToISO(undefined), /Bad format dd\.MM\.yyyy/)
    assert.throws(() => norwegianDateToISO(null), /Bad format dd\.MM\.yyyy/)
  })

  test('rejects a date with surrounding whitespace', () => {
    assert.throws(() => norwegianDateToISO(' 10.08.2022'), /Bad format dd\.MM\.yyyy/)
    assert.throws(() => norwegianDateToISO('10.08.2022 '), /Bad format dd\.MM\.yyyy/)
  })

  test('rejects slash separators', () => {
    assert.throws(() => norwegianDateToISO('10/08/2022'), /Bad format dd\.MM\.yyyy/)
  })

  test('an out-of-range day or month passes the format check and rolls over (current behaviour)', () => {
    // The regex only validates shape, not calendar validity, so Date.UTC normalises the overflow.
    assert.equal(norwegianDateToISO('32.13.2024'), '2025-02-01T00:00:00.000Z')
    assert.equal(norwegianDateToISO('31.02.2023'), '2023-03-03T00:00:00.000Z')
  })
})
