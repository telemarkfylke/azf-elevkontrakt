'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { buildHeldBackSection, HELD_ESCALATION_DAYS } = require('../serverJobs/xledgerInvoiceImport.js')

// Fixed "now" so the age arithmetic is deterministic.
const NOW = new Date('2026-09-04T12:00:00.000Z').getTime()
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

const makeSkip = (overrides = {}) => ({
  invoiceId: 'inv-1',
  customerContractId: 'contract-1',
  studentName: 'Test Elev',
  recipientName: 'Test Foresatt',
  recipientFnr: '010199*****',
  createdTimeStamp: daysAgo(1),
  documentType: 'regular',
  reason: 'Mottakeren er ikke importert til Xledger (isImportedToXledger = "false")',
  ...overrides,
})

const build = (skips) => buildHeldBackSection(skips, { now: NOW })
const textBlocks = (blocks) => blocks.filter(b => b.type === 'TextBlock').map(b => b.text)
const factSets = (blocks) => blocks.filter(b => b.type === 'FactSet')
const factValue = (factSet, title) => factSet.facts.find(f => f.title === title)?.value

describe('buildHeldBackSection - the count', () => {
  test('an empty list still reports 0, so it is visible that the check ran', () => {
    const blocks = build([])
    assert.equal(factSets(blocks).length, 0)
    assert.match(textBlocks(blocks)[0], /\*\*0\*\* faktura\(er\) ble \*\*ikke\*\* sendt til Xledger/)
  })

  test('the count is the number of held invoices', () => {
    const blocks = build([makeSkip(), makeSkip({ invoiceId: 'inv-2' })])
    assert.match(textBlocks(blocks)[0], /\*\*2\*\* faktura\(er\)/)
    assert.equal(factSets(blocks).length, 2)
  })

  test('each invoice carries what is needed to act on it', () => {
    const [facts] = factSets(build([makeSkip({ documentType: 'pcIkkeInnlevert' })]))
    assert.equal(factValue(facts, 'Elev:'), 'Test Elev')
    assert.equal(factValue(facts, 'Mottaker:'), 'Test Foresatt (010199*****)')
    assert.equal(factValue(facts, 'Kontrakt ID:'), 'contract-1')
    assert.equal(factValue(facts, 'Faktura ID:'), 'inv-1')
    assert.equal(factValue(facts, 'Collection:'), 'pcIkkeInnlevert')
    assert.equal(factValue(facts, 'Ventet:'), '1 dag(er)')
  })

  test('a contract that was not found reads as "ikke funnet" rather than blank', () => {
    const [facts] = factSets(build([makeSkip({ documentType: null })]))
    assert.equal(factValue(facts, 'Collection:'), 'ikke funnet')
  })
})

describe('buildHeldBackSection - escalation', () => {
  test('no escalation line while every hold is fresh', () => {
    const blocks = build([makeSkip({ createdTimeStamp: daysAgo(HELD_ESCALATION_DAYS - 1) })])
    assert.ok(!textBlocks(blocks).some(text => /Krever oppfølging/.test(text)))
  })

  test('escalates once a hold reaches the threshold', () => {
    const blocks = build([makeSkip({ createdTimeStamp: daysAgo(HELD_ESCALATION_DAYS) })])
    const escalation = textBlocks(blocks).find(text => /Krever oppfølging/.test(text))
    assert.ok(escalation, 'expected an escalation line')
    assert.match(escalation, new RegExp(`1 av disse har ventet i mer enn ${HELD_ESCALATION_DAYS} dager`))
  })

  test('counts only the holds past the threshold, not the whole list', () => {
    const blocks = build([
      makeSkip({ invoiceId: 'fresh', createdTimeStamp: daysAgo(2) }),
      makeSkip({ invoiceId: 'old-1', createdTimeStamp: daysAgo(30) }),
      makeSkip({ invoiceId: 'old-2', createdTimeStamp: daysAgo(90) }),
    ])
    const escalation = textBlocks(blocks).find(text => /Krever oppfølging/.test(text))
    assert.match(escalation, /2 av disse/)
  })

  test('the escalation line names the populations whose flag is never set automatically', () => {
    const blocks = build([makeSkip({ createdTimeStamp: daysAgo(20) })])
    const escalation = textBlocks(blocks).find(text => /Krever oppfølging/.test(text))
    assert.match(escalation, /manuelt i Xledger/)
    assert.match(escalation, /Ukjent/)
    assert.match(escalation, /pc-ikke-innlevert/)
  })

  test('an unknown age never escalates and says so instead of guessing', () => {
    const blocks = build([makeSkip({ createdTimeStamp: null }), makeSkip({ invoiceId: 'bad-date', createdTimeStamp: 'not-a-date' })])
    assert.ok(!textBlocks(blocks).some(text => /Krever oppfølging/.test(text)))
    for (const facts of factSets(blocks)) {
      assert.equal(factValue(facts, 'Ventet:'), 'ukjent (fakturaen mangler createdTimeStamp)')
    }
  })

  test('a createdTimeStamp in the future reads as 0 days, not a negative age', () => {
    const [facts] = factSets(build([makeSkip({ createdTimeStamp: daysAgo(-5) })]))
    assert.equal(factValue(facts, 'Ventet:'), '0 dag(er)')
  })

  test('a Date object works as well as an ISO string', () => {
    const [facts] = factSets(build([makeSkip({ createdTimeStamp: new Date(NOW - 3 * 24 * 60 * 60 * 1000) })]))
    assert.equal(factValue(facts, 'Ventet:'), '3 dag(er)')
  })
})

describe('buildHeldBackSection - ordering and the card size cap', () => {
  test('oldest first, so the holds that need attention survive the cap', () => {
    const blocks = build([
      makeSkip({ invoiceId: 'newest', createdTimeStamp: daysAgo(1) }),
      makeSkip({ invoiceId: 'oldest', createdTimeStamp: daysAgo(100) }),
      makeSkip({ invoiceId: 'middle', createdTimeStamp: daysAgo(10) }),
    ])
    const ids = factSets(blocks).map(f => factValue(f, 'Faktura ID:'))
    assert.deepEqual(ids, ['oldest', 'middle', 'newest'])
  })

  test('unknown ages sort last', () => {
    const blocks = build([
      makeSkip({ invoiceId: 'unknown', createdTimeStamp: null }),
      makeSkip({ invoiceId: 'known', createdTimeStamp: daysAgo(1) }),
    ])
    const ids = factSets(blocks).map(f => factValue(f, 'Faktura ID:'))
    assert.deepEqual(ids, ['known', 'unknown'])
  })

  test('caps the FactSets and says how many were left out', () => {
    const skips = Array.from({ length: 25 }, (_, i) => makeSkip({ invoiceId: `inv-${i}`, createdTimeStamp: daysAgo(i) }))
    const blocks = build(skips)
    assert.equal(factSets(blocks).length, 20)
    assert.ok(textBlocks(blocks).some(text => /\.\.\. og 5 flere, se loggen\./.test(text)))
    // The count in the heading is the full total, not the truncated list.
    assert.match(textBlocks(blocks)[0], /\*\*25\*\* faktura\(er\)/)
  })

  test('no overflow line when the list fits exactly', () => {
    const skips = Array.from({ length: 20 }, (_, i) => makeSkip({ invoiceId: `inv-${i}` }))
    const blocks = build(skips)
    assert.equal(factSets(blocks).length, 20)
    assert.ok(!textBlocks(blocks).some(text => /flere, se loggen/.test(text)))
  })

  test('does not mutate the caller\'s array', () => {
    const skips = [
      makeSkip({ invoiceId: 'newest', createdTimeStamp: daysAgo(1) }),
      makeSkip({ invoiceId: 'oldest', createdTimeStamp: daysAgo(100) }),
    ]
    build(skips)
    assert.deepEqual(skips.map(s => s.invoiceId), ['newest', 'oldest'])
  })
})
