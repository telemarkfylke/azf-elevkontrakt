'use strict'

/**
 * parseCSVString was extracted out of readAndParseCSV so an uploaded file could be parsed without a
 * path on disk (bulkInvoiceFromFile.js). These lock the behaviour every existing caller already
 * depends on, plus the one thing the extraction added: stripping the UTF-8 BOM Excel writes in front
 * of the first header. That BOM is what turns column 'fnr' into '﻿fnr' and makes a
 * fødselsnummer lookup miss every row while the run still reports success.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { parseCSVString } = require('../readAndParseCSV.js')

describe('parseCSVString - delimiter detection', () => {
  test('uses ; when the header has more semicolons than commas (Norwegian Excel)', () => {
    const rows = parseCSVString('fnr;navn;klasse\n01010112345;Ola Nordmann;2ELEA')
    assert.deepEqual(rows, [{ fnr: '01010112345', navn: 'Ola Nordmann', klasse: '2ELEA' }])
  })

  test('uses , otherwise', () => {
    const rows = parseCSVString('fnr,navn\n01010112345,Ola Nordmann')
    assert.deepEqual(rows, [{ fnr: '01010112345', navn: 'Ola Nordmann' }])
  })

  test('a single-column file has neither delimiter and still parses', () => {
    assert.deepEqual(parseCSVString('fnr\n01010112345'), [{ fnr: '01010112345' }])
  })
})

describe('parseCSVString - BOM', () => {
  test('strips the UTF-8 BOM from the first header', () => {
    const rows = parseCSVString('﻿fnr;navn\n01010112345;Ola')
    assert.deepEqual(Object.keys(rows[0]), ['fnr', 'navn'], 'the BOM must not survive into the key')
    assert.equal(rows[0].fnr, '01010112345')
  })

  test('a caller that also strips the BOM itself still works (miscCleanUpJobs does)', () => {
    const rows = parseCSVString('﻿Email;Full Name\na@b.no;Ola')
    const restripped = Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key.replace(/^﻿/, ''), value]))
    assert.deepEqual(restripped, { Email: 'a@b.no', 'Full Name': 'Ola' })
  })
})

describe('parseCSVString - quoting', () => {
  test('a quoted field may contain the delimiter', () => {
    const rows = parseCSVString('navn;adresse\nOla;"Storgata 1, Skien"')
    assert.equal(rows[0].adresse, 'Storgata 1, Skien')
  })

  test('a quoted field may contain the semicolon delimiter too', () => {
    const rows = parseCSVString('navn;notat\nOla;"a;b;c"')
    assert.equal(rows[0].notat, 'a;b;c')
  })

  test('"" inside a quoted field is a literal quote', () => {
    const rows = parseCSVString('navn;kallenavn\nOla;"Ola ""Store"" Nordmann"')
    assert.equal(rows[0].kallenavn, 'Ola "Store" Nordmann')
  })
})

describe('parseCSVString - shape', () => {
  test('a short row fills missing columns with empty strings, never undefined', () => {
    const rows = parseCSVString('a;b;c\n1;2')
    assert.deepEqual(rows[0], { a: '1', b: '2', c: '' })
  })

  test('values and headers are trimmed', () => {
    const rows = parseCSVString(' fnr ; navn \n 01010112345 ; Ola ')
    assert.deepEqual(rows[0], { fnr: '01010112345', navn: 'Ola' })
  })

  test('CRLF and lone CR line endings are handled', () => {
    assert.equal(parseCSVString('fnr;navn\r\n1;Ola\r\n2;Kari').length, 2)
    assert.equal(parseCSVString('fnr;navn\r1;Ola\r2;Kari').length, 2)
  })

  test('blank lines between rows are dropped', () => {
    assert.equal(parseCSVString('fnr\n1\n\n2\n').length, 2)
  })

  test('a header-only file gives no rows', () => {
    assert.deepEqual(parseCSVString('fnr;navn'), [])
  })

  test('empty and whitespace-only input give []', () => {
    assert.deepEqual(parseCSVString(''), [])
    assert.deepEqual(parseCSVString('   \n  '), [])
  })

  test('returns [] rather than throwing for a non-string - callers treat [] as abort', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.deepEqual(parseCSVString(value), [], `${JSON.stringify(value)} must not throw`)
    }
  })
})
