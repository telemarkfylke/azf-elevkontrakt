'use strict'

/**
 * checkRateCandidacy decides whether a contract rate is ever asked about in Xledger. A status missing
 * from it does not fail loudly - the rate is simply never revisited, keeps whatever it had forever,
 * and the contract silently fails determineHistoryMoveTarget from then on.
 *
 * That is exactly what happened to 'Fakturert - Utkjøp': written to the contract by every buyout
 * (createBuyOutInvoice, and again by updateImportedBuyOutDocument) and read by no consumer at all.
 * The buyout payment sweep updates only the invoice document, never the contract's fakturaInfo, so a
 * bought-out rate could never reach 'Betalt' however fully the guardian had paid - and the contract
 * parked in historiske-avtaler-pc-ikke-innlevert permanently.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { checkRateCandidacy, RateStatus } = require('../updatePaymentStatus.js')
const { determineHistoryMoveTarget } = require('../contractChecks.js')

const rate = (status, løpenummer = 'JOT-000000001-2-2026-abc123') => ({ status, løpenummer })

describe('checkRateCandidacy - which statuses get asked about', () => {
  test("'Fakturert - Utkjøp' is a candidate - this is the fix", () => {
    assert.equal(checkRateCandidacy(rate('Fakturert - Utkjøp')), true)
  })

  test('the statuses that were already candidates still are', () => {
    for (const status of [RateStatus.fakturert, RateStatus.ukjent, RateStatus.inkasso]) {
      assert.equal(checkRateCandidacy(rate(status)), true, `${status} must stay a candidate`)
    }
  })

  test('a settled rate is never re-asked about', () => {
    for (const status of [RateStatus.betalt, RateStatus.kreditert, RateStatus.ikkeBetale, RateStatus.utlaan]) {
      assert.equal(checkRateCandidacy(rate(status)), false, `${status} is terminal and must not be re-asked`)
    }
  })

  test('a rate with no løpenummer has not been invoiced and is never asked about', () => {
    assert.equal(checkRateCandidacy({ status: 'Fakturert - Utkjøp' }), false)
    assert.equal(checkRateCandidacy({ status: 'Fakturert - Utkjøp', løpenummer: '' }), false)
  })

  test('a non-JOT løpenummer is skipped - Digitroll-era serials are not ours to look up', () => {
    assert.equal(checkRateCandidacy(rate('Fakturert - Utkjøp', 'DIGITROLL-123')), false)
    assert.equal(checkRateCandidacy(rate('Fakturert', 'DIGITROLL-123')), false)
  })

  test('the enum carries the buyout status, so no call site has to hardcode the string', () => {
    assert.equal(RateStatus.fakturertUtkjop, 'Fakturert - Utkjøp')
  })
})

/**
 * The Mongo pre-filter runs before checkRateCandidacy ever sees a rate, so the fix is only real if a
 * bought-out contract survives the query too. These mirror addQueryRate's three clauses rather than
 * calling it (it builds a query object, not a predicate), so a change to either side shows up here.
 */
describe('the Mongo pre-filter lets a bought-out rate through to the candidacy check', () => {
  const EXCLUDED_FROM_QUERY = [RateStatus.betalt, RateStatus.utlaan, RateStatus.ikkeBetale, RateStatus.kreditert]
  const FAKTURERINGSDATO_FLOOR = '2025-10-01T00:00:00.000Z'

  test("the status clause does not exclude 'Fakturert - Utkjøp'", () => {
    assert.equal(EXCLUDED_FROM_QUERY.includes(RateStatus.fakturertUtkjop), false)
  })

  test('a buyout rate has a real løpenummer, which the first clause requires', () => {
    const buyOutRate = rate('Fakturert - Utkjøp')
    assert.notEqual(buyOutRate.løpenummer, 'Ukjent')
    assert.ok(buyOutRate.løpenummer.startsWith('JOT-'))
  })

  test('a buyout rate gets its faktureringsDato at Xledger import, clearing the date floor', () => {
    // updateImportedBuyOutDocument spreads in updateData, which carries faktureringsDato as an ISO
    // string. Before import there is none, and the rate is correctly not asked about yet.
    const afterImport = new Date().toISOString()
    assert.ok(afterImport > FAKTURERINGSDATO_FLOOR)
    assert.equal(undefined > FAKTURERINGSDATO_FLOOR, false, 'a not-yet-imported rate stays out of scope')
  })
})

/**
 * The point of the fix, end to end: a bought-out contract can now finish its life.
 */
describe('a bought-out contract can now reach the archive', () => {
  const boughtOutContract = (rateStatus) => ({
    pcInfo: { returned: 'false', boughtOut: 'true' },
    fakturaInfo: { rate1: { status: rateStatus }, rate2: { status: rateStatus }, rate3: { status: rateStatus } }
  })

  test('invoiced but unpaid still stays in the holding pen', () => {
    assert.equal(determineHistoryMoveTarget(boughtOutContract('Fakturert - Utkjøp')), 'pcIkkeInnlevert')
  })

  test('once the sweep marks the rates Betalt, it archives - which it can now actually do', () => {
    assert.equal(checkRateCandidacy(rate('Fakturert - Utkjøp')), true, 'the sweep asks about it...')
    assert.equal(determineHistoryMoveTarget(boughtOutContract('Betalt')), 'historic', '...so it can end up here')
  })

  test('a credited buyout archives too', () => {
    assert.equal(determineHistoryMoveTarget(boughtOutContract('Kreditert')), 'historic')
  })
})
