'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { validateRoles } = require('../validateRoles')
const { decodeToken } = require('../decodeToken')

// ---- Helpers ---------------------------------------------------------------

const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

// jwt-decode does not verify signatures, so an unsigned token is enough to
// exercise the role logic. No network, no key material, no real tenant.
const makeRawToken = (payload) => `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.signature`

const makeAuthHeader = (payload) => `Bearer ${makeRawToken(payload)}`

const makeTokenWithRoles = (roles) => makeAuthHeader({ roles })

// The real role strings used across src/functions/.
const ADMIN = 'elevkontrakt.administrator-readwrite'
const READ = 'elevkontrakt.read'
const BILLING = 'elevkontrakt.billing-readwrite'
const SERVICEDESK = 'elevkontrakt.itservicedesk-readwrite'

// =====================================================================
// validateRoles — the single authorization gate behind every role check in
// src/functions/. Returning true for a token that should not pass exposes
// contract and fnr data, so both directions matter equally here.
// =====================================================================

describe('validateRoles', () => {
  test('returns false when no required roles are given', () => {
    assert.equal(validateRoles(makeTokenWithRoles([ADMIN])), false)
  })

  test('returns false when the required roles argument is an empty string', () => {
    assert.equal(validateRoles(makeTokenWithRoles([ADMIN]), ''), false)
  })

  test('returns false when no token is given', () => {
    assert.equal(validateRoles(undefined, [ADMIN]), false)
  })

  test('returns false when the token is an empty string', () => {
    assert.equal(validateRoles('', [ADMIN]), false)
  })

  test('returns true when the token carries the required role', () => {
    assert.equal(validateRoles(makeTokenWithRoles([ADMIN]), [ADMIN]), true)
  })

  test('returns false when the token carries a different role', () => {
    assert.equal(validateRoles(makeTokenWithRoles([READ]), [ADMIN]), false)
  })

  test('returns false when the token carries no roles at all', () => {
    assert.equal(validateRoles(makeTokenWithRoles([]), [ADMIN]), false)
  })

  test('returns true when one of several token roles matches', () => {
    assert.equal(validateRoles(makeTokenWithRoles([READ, BILLING, ADMIN]), [ADMIN]), true)
  })

  test('returns true when the token role matches any one of several accepted roles', () => {
    assert.equal(validateRoles(makeTokenWithRoles([SERVICEDESK]), [ADMIN, SERVICEDESK, READ]), true)
  })

  test('returns false when none of several token roles match any accepted role', () => {
    assert.equal(validateRoles(makeTokenWithRoles(['some.other.role', 'another.role']), [ADMIN, READ]), false)
  })

  test('matching ignores the casing of the roles in the token', () => {
    assert.equal(validateRoles(makeTokenWithRoles(['Elevkontrakt.Administrator-ReadWrite']), [ADMIN]), true)
  })

  test('matching ignores the casing of the required roles', () => {
    assert.equal(validateRoles(makeTokenWithRoles([ADMIN]), ['ELEVKONTRAKT.ADMINISTRATOR-READWRITE']), true)
  })

  test('matching ignores casing on both sides at once', () => {
    assert.equal(validateRoles(makeTokenWithRoles(['ELEVKONTRAKT.READ']), ['Elevkontrakt.Read']), true)
  })

  test('matching is otherwise exact — a role that is a prefix of an accepted role does not pass', () => {
    assert.equal(validateRoles(makeTokenWithRoles(['elevkontrakt']), [ADMIN]), false)
  })

  test('matching is otherwise exact — a role with a trailing suffix does not pass', () => {
    assert.equal(validateRoles(makeTokenWithRoles(['elevkontrakt.read-extra']), [READ]), false)
  })

  test('the real handleDbRequest read role set accepts a read-only token', () => {
    const accepted = [ADMIN, SERVICEDESK, READ, 'elevkontrakt.readwrite', 'elevkontrakt.skoleadministrator-write']

    assert.equal(validateRoles(makeTokenWithRoles([READ]), accepted), true)
  })

  test('the real delete-endpoint role set rejects a read-only token', () => {
    // handleDbRequest.js:192 guards the destructive path with administrator only.
    assert.equal(validateRoles(makeTokenWithRoles([READ]), [ADMIN]), false)
  })

  test('ignores other claims in the token and looks only at roles', () => {
    const token = makeAuthHeader({ upn: 'someone@telemarkfylke.no', oid: 'abc', roles: [ADMIN] })

    assert.equal(validateRoles(token, [ADMIN]), true)
  })

  test('a scheme other than Bearer still works, since only the second whitespace-separated part is read', () => {
    const token = makeTokenWithRoles([ADMIN]).replace('Bearer ', 'Basic ')

    assert.equal(validateRoles(token, [ADMIN]), true)
  })
})

// =====================================================================
// Malformed input — validateRoles does not guard these, so it throws rather
// than denying access. Locked here so the behaviour cannot change unnoticed:
// a caller that stops throwing would need to start returning false.
// =====================================================================

describe('validateRoles - malformed input', () => {
  test('throws when the header has no scheme prefix, because there is no second part to decode', () => {
    assert.throws(() => validateRoles(makeRawToken({ roles: [ADMIN] }), [ADMIN]), TypeError)
  })

  test('throws when the token has no roles claim', () => {
    assert.throws(() => validateRoles(makeAuthHeader({ upn: 'someone@telemarkfylke.no' }), [ADMIN]), TypeError)
  })

  test('throws when the roles claim is a string rather than an array', () => {
    assert.throws(() => validateRoles(makeAuthHeader({ roles: ADMIN }), [ADMIN]), TypeError)
  })

  test('throws when the token is not a decodable JWT', () => {
    assert.throws(() => validateRoles('Bearer not-a-jwt', [ADMIN]))
  })
})

// =====================================================================
// decodeToken — used directly by validateRoles and by the handlers to read
// the upn for audit fields.
// =====================================================================

describe('decodeToken', () => {
  test('returns null for a falsy token', () => {
    assert.equal(decodeToken(undefined, ['roles']), null)
    assert.equal(decodeToken('', ['roles']), null)
    assert.equal(decodeToken(null, ['roles']), null)
  })

  test('returns only the requested claims', () => {
    const raw = makeRawToken({ upn: 'a@b.no', roles: ['r1'], oid: 'oid-1' })

    assert.deepEqual(decodeToken(raw, ['oid']), { oid: 'oid-1' })
  })

  test('returns several requested claims in one object', () => {
    const raw = makeRawToken({ upn: 'a@b.no', roles: ['r1'], oid: 'oid-1' })

    assert.deepEqual(decodeToken(raw, ['upn', 'roles']), { upn: 'a@b.no', roles: ['r1'] })
  })

  test('defaults to upn and roles when no claim list is given', () => {
    const raw = makeRawToken({ upn: 'a@b.no', roles: ['r1'], oid: 'oid-1' })

    assert.deepEqual(decodeToken(raw), { upn: 'a@b.no', roles: ['r1'] })
  })

  test('a requested claim that is absent from the token comes back undefined', () => {
    const raw = makeRawToken({ upn: 'a@b.no' })

    assert.deepEqual(decodeToken(raw, ['upn', 'roles']), { upn: 'a@b.no', roles: undefined })
  })

  test('an empty claim list returns an empty object, since only a falsy list triggers the default', () => {
    const raw = makeRawToken({ upn: 'a@b.no', roles: ['r1'] })

    assert.deepEqual(decodeToken(raw, []), {})
  })

  test('does not verify the signature — a token with a bogus signature still decodes', () => {
    const raw = `${base64url({ alg: 'none' })}.${base64url({ upn: 'a@b.no' })}.totally-invalid`

    assert.deepEqual(decodeToken(raw, ['upn']), { upn: 'a@b.no' })
  })

  test('throws on a token that is not decodable', () => {
    assert.throws(() => decodeToken('not-a-jwt', ['upn']))
  })
})
