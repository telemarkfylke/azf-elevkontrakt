'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { validateHistoryRateEdit, planHistoryRateEdit, planInheritedUpdates, isRemisseRate, CONFLICT } = require('../historyRateEdit')

const ISO = '2026-10-08T00:00:00.000Z'

describe('validateHistoryRateEdit', () => {
  test('accepts a partial payment', () => {
    assert.equal(validateHistoryRateEdit({ 'fakturaInfo.rate2.betaltBeløp': '600', 'fakturaInfo.rate2.sistInnbetaltDato': ISO }), null)
  })

  test('accepts both statuses, a cleared date and decimals', () => {
    assert.equal(validateHistoryRateEdit({ 'fakturaInfo.rate1.status': 'Betalt' }), null)
    assert.equal(validateHistoryRateEdit({ 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltDato': '' }), null)
    assert.equal(validateHistoryRateEdit({ 'fakturaInfo.rate1.betaltBeløp': '600.5' }), null)
  })

  test('rejects empty data', () => {
    assert.ok(validateHistoryRateEdit({}))
    assert.ok(validateHistoryRateEdit(null))
  })

  test('rejects fields outside the whitelist', () => {
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.sum': '0' }))
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate4.status': 'Betalt' }))
    assert.ok(validateHistoryRateEdit({ 'elevInfo.navn': 'x' }))
  })

  test('rejects values that are not strings', () => {
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.betaltBeløp': ['100'] }))
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.betaltBeløp': 100 }))
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.editReasonCustom': { x: 1 } }))
  })

  test('rejects other statuses', () => {
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.status': 'Kreditert' }))
  })

  test('rejects amounts that are not plain numbers', () => {
    for (const value of ['-1', 'abc', '', ' ', '\t', '1 118', '1,5', '1.123', '1e3']) {
      assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.betaltBeløp': value }), `"${value}" should be refused`)
    }
  })

  test('rejects dates that are not real, too old or in the future', () => {
    for (const value of ['i går', '0026-09-15T00:00:00.000Z', '2014-12-31T00:00:00.000Z', '2999-01-01T00:00:00.000Z']) {
      assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.betaltDato': value }), `${value} should be refused`)
      assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.sistInnbetaltDato': value }), `${value} should be refused`)
    }
  })

  test('rejects a long comment', () => {
    assert.ok(validateHistoryRateEdit({ 'fakturaInfo.rate1.editReasonCustom': 'x'.repeat(129) }))
  })
})

describe('isRemisseRate', () => {
  test('inkasso, and Betalt only when set here', () => {
    assert.equal(isRemisseRate({ status: 'Overført inkasso' }), true)
    assert.equal(isRemisseRate({ status: 'Betalt', betaltBeløp: '1118' }), true)
    assert.equal(isRemisseRate({ status: 'Betalt' }), false)
    assert.equal(isRemisseRate({ status: 'Kreditert' }), false)
  })
})

describe('planHistoryRateEdit', () => {
  // rate1 paid normally, rate2 inkasso with 400 paid, rate3 not invoiced, rate set to Betalt here in paidDoc.
  const doc = () => ({
    fakturaInfo: {
      rate1: { status: 'Betalt', sum: '1118' },
      rate2: { status: 'Overført inkasso', sum: '1118', betaltBeløp: '400' },
      rate3: { status: 'Ikke Fakturert', sum: '1118' }
    }
  })
  const seen = { 'fakturaInfo.rate2.status': 'Overført inkasso', 'fakturaInfo.rate2.betaltBeløp': '400' }
  const paidDoc = () => ({ fakturaInfo: { rate1: { status: 'Betalt', sum: '1118', betaltBeløp: '1118' } } })
  const seenPaid = { 'fakturaInfo.rate1.status': 'Betalt', 'fakturaInfo.rate1.betaltBeløp': '1118' }
  const plan = (data, document = doc(), expected = seen) => planHistoryRateEdit(document, data, expected, 'admin@test.no', ISO)

  test('builds the change log on the server and locks on what the admin saw', () => {
    const result = plan({ 'fakturaInfo.rate2.betaltBeløp': '1000', 'fakturaInfo.rate2.sistInnbetaltDato': ISO })
    assert.deepEqual(result.filter, { 'fakturaInfo.rate2.status': 'Overført inkasso', 'fakturaInfo.rate2.betaltBeløp': '400' })
    assert.deepEqual(result.changeLog[0], { field: 'fakturaInfo.rate2.betaltBeløp', oldValue: '400', newValue: '1000', timestamp: ISO, changedBy: 'admin@test.no' })
    assert.equal(result.changeLog[1].oldValue, null)
  })

  test('locks a missing betaltBeløp as null', () => {
    const result = plan({ 'fakturaInfo.rate1.betaltBeløp': '100' }, { fakturaInfo: { rate1: { status: 'Overført inkasso', sum: '1118' } } }, { 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': null })
    assert.equal(result.filter['fakturaInfo.rate1.betaltBeløp'], null)
  })

  test('409 when the rate changed since the admin opened it', () => {
    assert.deepEqual(plan({ 'fakturaInfo.rate2.betaltBeløp': '1000' }, doc(), { ...seen, 'fakturaInfo.rate2.betaltBeløp': '' }), { status: 409, error: CONFLICT })
  })

  test('400, not 409 or a crash, when expected is missing or not an object', () => {
    for (const expected of [undefined, null, 'x', 1, true]) {
      assert.equal(planHistoryRateEdit(doc(), { 'fakturaInfo.rate2.betaltBeløp': '1000' }, expected, 'a').status, 400)
    }
    assert.equal(plan({ 'fakturaInfo.rate2.betaltBeløp': '1000' }, doc(), { 'fakturaInfo.rate2.status': 'Overført inkasso' }).status, 400)
  })

  test('400 when the rate does not exist', () => {
    assert.match(plan({ 'fakturaInfo.rate1.status': 'Betalt' }, { fakturaInfo: {} }, { 'fakturaInfo.rate1.status': 'Betalt', 'fakturaInfo.rate1.betaltBeløp': null }).error, /har ikke faktura 1/)
  })

  // Each test below passes the lock, so only the rule it names can refuse it.
  test('refuses rates that are not remisse rates', () => {
    assert.match(plan({ 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltDato': '', 'fakturaInfo.rate1.betaltBeløp': '0', 'fakturaInfo.rate1.editReasonCustom': 'x' }, doc(), { 'fakturaInfo.rate1.status': 'Betalt', 'fakturaInfo.rate1.betaltBeløp': null }).error, /kan ikke endres her/)
    assert.match(plan({ 'fakturaInfo.rate3.status': 'Betalt', 'fakturaInfo.rate3.betaltDato': ISO, 'fakturaInfo.rate3.betaltBeløp': '1118' }, doc(), { 'fakturaInfo.rate3.status': 'Ikke Fakturert', 'fakturaInfo.rate3.betaltBeløp': null }).error, /kan ikke endres her/)
  })

  test('refuses an unchanged status', () => {
    assert.match(plan({ 'fakturaInfo.rate2.status': 'Overført inkasso', 'fakturaInfo.rate2.betaltDato': '' }).error, /status er uendret/)
  })

  test('refuses an amount above the sum', () => {
    assert.match(plan({ 'fakturaInfo.rate2.betaltBeløp': '1119' }).error, /høyere enn summen/)
  })

  test('lowering the amount needs a Forklaring', () => {
    assert.match(plan({ 'fakturaInfo.rate2.betaltBeløp': '100' }).error, /forklaring/)
    assert.match(plan({ 'fakturaInfo.rate2.betaltBeløp': '100', 'fakturaInfo.rate2.editReasonCustom': '  ' }).error, /forklaring/)
    assert.ok(plan({ 'fakturaInfo.rate2.betaltBeløp': '100', 'fakturaInfo.rate2.editReasonCustom': 'Skrev 400, var 100' }).changeLog)
  })

  test('dates only change together with what they belong to', () => {
    assert.match(plan({ 'fakturaInfo.rate2.betaltDato': ISO }).error, /betaltDato kan bare endres sammen med status/)
    assert.match(plan({ 'fakturaInfo.rate2.sistInnbetaltDato': ISO }).error, /sistInnbetaltDato kan bare endres sammen med beløpet/)
  })

  test('Betalt needs betaltBeløp and betaltDato', () => {
    assert.match(plan({ 'fakturaInfo.rate2.status': 'Betalt', 'fakturaInfo.rate2.betaltDato': ISO }).error, /betaltBeløp må være med/)
    assert.match(plan({ 'fakturaInfo.rate2.status': 'Betalt', 'fakturaInfo.rate2.betaltBeløp': '1118' }).error, /betaltDato må være med/)
    assert.ok(plan({ 'fakturaInfo.rate2.status': 'Betalt', 'fakturaInfo.rate2.betaltBeløp': '1118', 'fakturaInfo.rate2.betaltDato': ISO }).changeLog)
  })

  test('back to inkasso must clear betaltDato', () => {
    assert.match(plan({ 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': '0', 'fakturaInfo.rate1.editReasonCustom': 'Feil' }, paidDoc(), seenPaid).error, /betaltDato må tømmes/)
    assert.ok(plan({ 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltDato': '', 'fakturaInfo.rate1.betaltBeløp': '400', 'fakturaInfo.rate1.editReasonCustom': 'Feil' }, paidDoc(), seenPaid).changeLog)
  })

  test('status must match what is paid', () => {
    assert.match(plan({ 'fakturaInfo.rate2.status': 'Betalt', 'fakturaInfo.rate2.betaltBeløp': '900', 'fakturaInfo.rate2.betaltDato': ISO }).error, /hele summen er betalt/)
    assert.match(plan({ 'fakturaInfo.rate2.betaltBeløp': '1118' }).error, /status må være Betalt/)
    assert.match(plan({ 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltDato': '' }, paidDoc(), seenPaid).error, /status må være Betalt/)
  })

  test('a comment on its own is allowed', () => {
    assert.ok(plan({ 'fakturaInfo.rate2.editReasonCustom': 'Remisse 1 500 kr fordelt' }).changeLog)
  })

  test('reads sums with spaces and decimal comma like the frontend', () => {
    const spaced = { fakturaInfo: { rate1: { status: 'Overført inkasso', sum: '1 118' } } }
    const seen1 = { 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': null }
    assert.match(plan({ 'fakturaInfo.rate1.betaltBeløp': '1119' }, spaced, seen1).error, /høyere enn summen/)
    assert.ok(plan({ 'fakturaInfo.rate1.status': 'Betalt', 'fakturaInfo.rate1.betaltBeløp': '1118', 'fakturaInfo.rate1.betaltDato': ISO }, spaced, seen1).changeLog)
  })
})

describe('planInheritedUpdates', () => {
  const document = {
    _id: 'h1',
    elevInfo: { fnr: '12345678901' },
    unSignedskjemaInfo: { kontraktType: 'Leieavtale' },
    fakturaInfo: { rate2: { status: 'Overført inkasso', sum: '1118', løpenummer: 'DT-1', faktureringsår: '2023', faktureringsDato: '2023-10-31' } }
  }
  const data = { 'fakturaInfo.rate2.betaltBeløp': '600', 'fakturaInfo.rate2.sistInnbetaltDato': ISO }
  const changeLog = [{ field: 'fakturaInfo.rate2.betaltBeløp', oldValue: null, newValue: '600' }, { field: 'fakturaInfo.rate2.sistInnbetaltDato', oldValue: null, newValue: ISO }]

  test('matches unchanged copies for the same elev and type, and sets the same fields', () => {
    const [update] = planInheritedUpdates(document, data, changeLog)
    assert.deepEqual(update.filter, {
      'elevInfo.fnr': '12345678901',
      'unSignedskjemaInfo.kontraktType': { $regex: '^Leieavtale$', $options: 'i' },
      'fakturaInfo.rate2.status': 'Overført inkasso',
      'fakturaInfo.rate2.sum': '1118',
      'fakturaInfo.rate2.betaltBeløp': null,
      'fakturaInfo.rate2.løpenummer': 'DT-1',
      'fakturaInfo.rate2.faktureringsår': '2023',
      'fakturaInfo.rate2.faktureringsDato': '2023-10-31'
    })
    assert.deepEqual(update.set, data)
    assert.equal(update.changeLog.length, 2)
    assert.equal(update.changeLog[0].source, 'historikk')
    assert.equal(update.changeLog[0].historyContractId, 'h1')
  })

  test('nothing when the elev or type is unknown', () => {
    assert.deepEqual(planInheritedUpdates({ ...document, elevInfo: { fnr: 'Ukjent' } }, data, changeLog), [])
    assert.deepEqual(planInheritedUpdates({ ...document, unSignedskjemaInfo: {} }, data, changeLog), [])
  })
})
