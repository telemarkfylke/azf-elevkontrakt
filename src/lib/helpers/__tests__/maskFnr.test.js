'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { maskFnr, redactFnrInText, sanitizeErrorForLogging } = require('../maskFnr')

describe('maskFnr', () => {
  test('keeps the first 6 digits (birthdate) and masks the rest for an 11-digit fnr', () => {
    assert.equal(maskFnr('01015512345'), '010155*****')
  })

  test('masks the whole value when it is 6 characters or shorter', () => {
    assert.equal(maskFnr('123456'), '******')
    assert.equal(maskFnr('123'), '***')
  })

  test('still masks anything after the first 6 characters for a longer, malformed value', () => {
    assert.equal(maskFnr('0101551234567'), '010155*******')
  })

  test('returns "Ukjent" for falsy or non-string input', () => {
    assert.equal(maskFnr(undefined), 'Ukjent')
    assert.equal(maskFnr(null), 'Ukjent')
    assert.equal(maskFnr(''), 'Ukjent')
    assert.equal(maskFnr(1234), 'Ukjent')
  })
})

describe('redactFnrInText', () => {
  test('masks every 11-digit run found in a larger string', () => {
    const input = 'Feil for ssn 01015512345 og foresatt 02026623456'
    assert.equal(redactFnrInText(input), 'Feil for ssn 010155***** og foresatt 020266*****')
  })

  test('leaves text with no 11-digit runs unchanged', () => {
    assert.equal(redactFnrInText('Internal server error'), 'Internal server error')
  })

  test('passes through non-string input unchanged', () => {
    assert.equal(redactFnrInText(undefined), undefined)
    assert.equal(redactFnrInText(null), null)
  })
})

describe('sanitizeErrorForLogging', () => {
  test('returns a generic message when error is falsy', () => {
    assert.deepEqual(sanitizeErrorForLogging(undefined), { message: 'Unknown error' })
  })

  test('redacts an fnr found in the error message', () => {
    const result = sanitizeErrorForLogging({ message: 'Person with ssn 01015512345 not found' })
    assert.equal(result.message, 'Person with ssn 010155***** not found')
  })

  test('includes the response status when present', () => {
    const result = sanitizeErrorForLogging({ message: 'fail', response: { status: 404 } })
    assert.equal(result.status, 404)
  })

  test('redacts an fnr in the request URL', () => {
    const result = sanitizeErrorForLogging({ message: 'fail', config: { url: 'https://fint.example.com/students/ssn/01015512345' } })
    assert.equal(result.url, 'https://fint.example.com/students/ssn/010155*****')
  })

  test('redacts an fnr in an object request body', () => {
    const result = sanitizeErrorForLogging({ message: 'fail', config: { data: { ssn: '01015512345' } } })
    assert.equal(result.requestData, '{"ssn":"010155*****"}')
  })

  test('redacts an fnr in an already-serialized string request body', () => {
    const result = sanitizeErrorForLogging({ message: 'fail', config: { data: JSON.stringify({ ssn: '01015512345' }) } })
    assert.equal(result.requestData, '{"ssn":"010155*****"}')
  })

  test('redacts an fnr echoed back in the response data', () => {
    const result = sanitizeErrorForLogging({ message: 'fail', response: { data: { errors: ['ssn 01015512345 is invalid'] } } })
    assert.equal(result.responseData, '{"errors":["ssn 010155***** is invalid"]}')
  })

  test('never includes request headers (e.g. the Authorization bearer token)', () => {
    const result = sanitizeErrorForLogging({
      message: 'fail',
      config: { url: 'https://example.com', headers: { Authorization: 'Bearer secret-token' } }
    })
    assert.equal(result.headers, undefined)
    assert.equal(JSON.stringify(result).includes('secret-token'), false)
  })

  test('never includes the raw error object itself', () => {
    const error = { message: 'fail', response: { status: 500, data: {} }, extraProp: 'should not leak' }
    const result = sanitizeErrorForLogging(error)
    assert.equal(result.extraProp, undefined)
  })
})
