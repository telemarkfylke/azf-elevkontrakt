'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { handleBuyOutInvoice, handleExtraInvoice } = require('../serverJobs/xledgerExtraInvoice.js')

// ---- Helpers ---------------------------------------------------------------

const makeBuyOutInvoice = (overrides = {}) => ({
  _id: 'invoice-id-001',
  type: 'buyOut',
  skoleOrgNr: '974568098',
  student: { fnr: '12345678901', navn: 'Test Elev', klasse: 'VG1' },
  recipient: { fnr: '98765432100' },
  rates: [
    { løpenummer: 'JOT-000000001-R-2024-00001', status: 'Ikke Fakturert' },
    { løpenummer: 'JOT-000000001-R-2024-00002', status: 'Ikke Fakturert' },
    { løpenummer: 'JOT-000000001-R-2024-00003', status: 'Ikke Fakturert' },
  ],
  ...overrides,
})

const makeExtraInvoice = (overrides = {}) => ({
  _id: 'invoice-id-002',
  type: 'extraInvoice',
  skoleOrgNr: '974568098',
  student: { fnr: '12345678901', navn: 'Test Elev' },
  recipient: { fnr: '98765432100' },
  itemsFromCart: [
    { _id: 'prod-1', name: 'Mus', price: 250, description: 'Standard mus', active: true, color: 'black', size: 'medium' },
    { _id: 'prod-2', name: 'Tastatur', price: 500, description: 'Trådløst', active: true, layout: 'nordic' },
  ],
  ...overrides,
})

const makeSchoolInfo = (overrides = {}) => ({
  orgNr: 974568098,
  xledgerInvoiceHeaderInfo: 'Kontakt skolen for spørsmål',
  xledgerSchoolProductNumber: '9999001',
  xledgerInvoiceCustomString: '999',
  ...overrides,
})

const makeStandardDeps = (capturedCsv) => ({
  getThisYearsPriceList: async () => ({
    prices: [{ klasse: 'VG1', price: 4000 }],
    exceptionsFromRegularPrices: [],
    exceptionsFromInvoiceFlow: [],
  }),
  hasInvoiceFlowException: () => false,
  schoolInfoList: [makeSchoolInfo()],
  returnCorrectPriceForStudent: () => '4000',
  generateInvoiceImportFile: async (type, csvData) => {
    if (capturedCsv) capturedCsv.push(...csvData)
    return { status: 200, type }
  },
  logger: () => {},
})

const makeExtraDeps = (capturedCsv, serialCounter = { n: 0 }) => ({
  schoolInfoList: [makeSchoolInfo()],
  generateSerialNumber: async () => `SN-${++serialCounter.n}`,
  standardFields: ['_id', 'name', 'price', 'description', 'active', 'metadata', 'auditLog'],
  generateInvoiceImportFile: async (type, csvData) => {
    if (capturedCsv) capturedCsv.push(...csvData)
    return { status: 200, type }
  },
})

// =====================================================================
// handleBuyOutInvoice
// =====================================================================

describe('handleBuyOutInvoice', () => {
  test('generates one CSV row per rate', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    assert.equal(csv.length, 3)
  })

  test('Order No equals rate.løpenummer', async () => {
    const csv = []
    const invoice = makeBuyOutInvoice()
    await handleBuyOutInvoice([invoice], makeStandardDeps(csv))
    assert.equal(csv[0]['Order No'], invoice.rates[0].løpenummer)
    assert.equal(csv[1]['Order No'], invoice.rates[1].løpenummer)
    assert.equal(csv[2]['Order No'], invoice.rates[2].løpenummer)
  })

  test('Line No increments from 1', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    assert.equal(csv[0]['Line No'], '1')
    assert.equal(csv[1]['Line No'], '2')
    assert.equal(csv[2]['Line No'], '3')
  })

  test('Dummy4 equals invoice._id', async () => {
    const csv = []
    const invoice = makeBuyOutInvoice({ _id: 'unique-invoice-id' })
    await handleBuyOutInvoice([invoice], makeStandardDeps(csv))
    for (const row of csv) {
      assert.equal(row.Dummy4, 'unique-invoice-id')
    }
  })

  test('Company No equals recipient.fnr', async () => {
    const csv = []
    const invoice = makeBuyOutInvoice({ recipient: { fnr: '11111111111' } })
    await handleBuyOutInvoice([invoice], makeStandardDeps(csv))
    for (const row of csv) {
      assert.equal(row['Company No'], '11111111111')
    }
  })

  test('Product is always 4651000', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    for (const row of csv) {
      assert.equal(row.Product, '4651000')
    }
  })

  test('Ready To Invoice is always 1', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    for (const row of csv) {
      assert.equal(row['Ready To Invoice'], '1')
    }
  })

  test('Unit Price comes from returnCorrectPriceForStudent', async () => {
    const csv = []
    const deps = {
      ...makeStandardDeps(csv),
      returnCorrectPriceForStudent: () => '5500',
    }
    await handleBuyOutInvoice([makeBuyOutInvoice()], deps)
    for (const row of csv) {
      assert.equal(row['Unit Price'], '5500')
    }
  })

  test('Header Info uses schoolInfo value when present', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    assert.equal(csv[0]['Header Info'], 'Kontakt skolen for spørsmål')
  })

  test('Header Info falls back when schoolInfo has no xledgerInvoiceHeaderInfo', async () => {
    const csv = []
    const deps = {
      ...makeStandardDeps(csv),
      schoolInfoList: [{ orgNr: 974568098 }],
    }
    await handleBuyOutInvoice([makeBuyOutInvoice()], deps)
    assert.equal(csv[0]['Header Info'], 'Spørsmål vedrørende faktura, ta kontakt med skolen din')
  })

  test('Tekst includes invoice counter (n/total) for each rate', async () => {
    const csv = []
    const invoice = makeBuyOutInvoice()
    await handleBuyOutInvoice([invoice], makeStandardDeps(csv))
    assert.match(csv[0]['Tekst (imp)'], /Faktura 1\/3/)
    assert.match(csv[1]['Tekst (imp)'], /Faktura 2\/3/)
    assert.match(csv[2]['Tekst (imp)'], /Faktura 3\/3/)
  })

  test('Tekst includes student name', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    assert.match(csv[0]['Tekst (imp)'], /Test Elev/)
  })

  test('skips invoice with exception and logs error', async () => {
    const csv = []
    const logged = []
    const deps = {
      ...makeStandardDeps(csv),
      hasInvoiceFlowException: () => true,
      logger: (level, msg) => logged.push({ level, msg }),
    }
    await handleBuyOutInvoice([makeBuyOutInvoice()], deps)
    assert.equal(csv.length, 0)
    assert.ok(logged.some(l => l.level === 'error'))
  })

  test('non-exception invoices are not skipped', async () => {
    const csv = []
    const deps = {
      ...makeStandardDeps(csv),
      hasInvoiceFlowException: (fnr) => fnr === 'exception-fnr',
    }
    const normal = makeBuyOutInvoice({ student: { fnr: 'normal-fnr', navn: 'Normal', klasse: 'VG1' } })
    const excepted = makeBuyOutInvoice({ _id: 'exc', student: { fnr: 'exception-fnr', navn: 'Skip', klasse: 'VG1' } })
    await handleBuyOutInvoice([normal, excepted], deps)
    assert.equal(csv.length, 3) // only normal's 3 rates
    assert.ok(csv.every(row => row['Your Ref'] === 'Normal'))
  })

  test('processes multiple invoices and generates rows for all', async () => {
    const csv = []
    const inv1 = makeBuyOutInvoice({ _id: 'a', rates: [{ løpenummer: 'L1', status: 'Ikke Fakturert' }] })
    const inv2 = makeBuyOutInvoice({ _id: 'b', rates: [{ løpenummer: 'L2', status: 'Ikke Fakturert' }, { løpenummer: 'L3', status: 'Ikke Fakturert' }] })
    await handleBuyOutInvoice([inv1, inv2], makeStandardDeps(csv))
    assert.equal(csv.length, 3)
  })

  test('each invoice row resets Line No counter', async () => {
    const csv = []
    const inv1 = makeBuyOutInvoice({ _id: 'a', rates: [{ løpenummer: 'L1', status: 'Ikke Fakturert' }] })
    const inv2 = makeBuyOutInvoice({ _id: 'b', rates: [{ løpenummer: 'L2', status: 'Ikke Fakturert' }] })
    await handleBuyOutInvoice([inv1, inv2], makeStandardDeps(csv))
    assert.equal(csv[0]['Line No'], '1')
    assert.equal(csv[1]['Line No'], '1')
  })

  test('passes buyOut type to generateInvoiceImportFile', async () => {
    let capturedType
    const deps = {
      ...makeStandardDeps([]),
      generateInvoiceImportFile: async (type) => { capturedType = type; return {} },
    }
    await handleBuyOutInvoice([makeBuyOutInvoice()], deps)
    assert.equal(capturedType, 'buyOut')
  })

  test('returns the result of generateInvoiceImportFile', async () => {
    const deps = {
      ...makeStandardDeps([]),
      generateInvoiceImportFile: async () => ({ status: 200, body: 'ok' }),
    }
    const result = await handleBuyOutInvoice([makeBuyOutInvoice()], deps)
    assert.deepEqual(result, { status: 200, body: 'ok' })
  })

  test('fixed fields: Service Type, SO Group, End Of Line, ImpSystem', async () => {
    const csv = []
    await handleBuyOutInvoice([makeBuyOutInvoice()], makeStandardDeps(csv))
    assert.equal(csv[0]['Service Type'], '465')
    assert.equal(csv[0]['SO Group'], '465')
    assert.equal(csv[0]['End Of Line'], 'X')
    assert.equal(csv[0]['ImpSystem'], 'Skoleutvikling - JOTNE')
  })
})

// =====================================================================
// handleExtraInvoice
// =====================================================================

describe('handleExtraInvoice', () => {
  test('generates one CSV row per product in itemsFromCart', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv.length, 2)
  })

  test('all rows for the same invoice share the same Order No (serial number)', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv[0]['Order No'], csv[1]['Order No'])
  })

  test('Order No is generated once per invoice, different invoices get different serial numbers', async () => {
    const csv = []
    const counter = { n: 0 }
    const inv1 = makeExtraInvoice({ _id: 'inv1' })
    const inv2 = makeExtraInvoice({ _id: 'inv2' })
    await handleExtraInvoice([inv1, inv2], makeExtraDeps(csv, counter))
    const sn1 = csv.filter(r => r.Dummy4 === 'inv1').map(r => r['Order No'])
    const sn2 = csv.filter(r => r.Dummy4 === 'inv2').map(r => r['Order No'])
    assert.ok(sn1.every(sn => sn === sn1[0]), 'All rows for inv1 share the same SN')
    assert.ok(sn2.every(sn => sn === sn2[0]), 'All rows for inv2 share the same SN')
    assert.notEqual(sn1[0], sn2[0], 'Different invoices have different SNs')
  })

  test('Line No increments from 1 per invoice', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv[0]['Line No'], '1')
    assert.equal(csv[1]['Line No'], '2')
  })

  test('Dummy4 equals invoice._id', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice({ _id: 'special-id' })], makeExtraDeps(csv))
    for (const row of csv) {
      assert.equal(row.Dummy4, 'special-id')
    }
  })

  test('Company No equals recipient.fnr', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice({ recipient: { fnr: '22222222222' } })], makeExtraDeps(csv))
    for (const row of csv) {
      assert.equal(row['Company No'], '22222222222')
    }
  })

  test('Product equals schoolInfo.xledgerSchoolProductNumber', async () => {
    const csv = []
    const deps = {
      ...makeExtraDeps(csv),
      schoolInfoList: [makeSchoolInfo({ xledgerSchoolProductNumber: '7654321' })],
    }
    await handleExtraInvoice([makeExtraInvoice()], deps)
    for (const row of csv) {
      assert.equal(row.Product, '7654321')
    }
  })

  test('Service Type and SO Group equal schoolInfo.xledgerInvoiceCustomString', async () => {
    const csv = []
    const deps = {
      ...makeExtraDeps(csv),
      schoolInfoList: [makeSchoolInfo({ xledgerInvoiceCustomString: '777' })],
    }
    await handleExtraInvoice([makeExtraInvoice()], deps)
    for (const row of csv) {
      assert.equal(row['Service Type'], '777')
      assert.equal(row['SO Group'], '777')
    }
  })

  test('Unit Price is product.price as string', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv[0]['Unit Price'], '250')
    assert.equal(csv[1]['Unit Price'], '500')
  })

  test('Tekst (imp) includes product.name', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.match(csv[0]['Tekst (imp)'], /Mus/)
    assert.match(csv[1]['Tekst (imp)'], /Tastatur/)
  })

  test('Tekst (imp) includes student name', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    for (const row of csv) {
      assert.match(row['Tekst (imp)'], /Test Elev/)
    }
  })

  test('Tekst (imp) includes non-standard fields', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.match(csv[0]['Tekst (imp)'], /color: black/)
    assert.match(csv[0]['Tekst (imp)'], /size: medium/)
    assert.match(csv[1]['Tekst (imp)'], /layout: nordic/)
  })

  test('Tekst (imp) does not include standard fields (_id, name, price, description, active)', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    const tekst = csv[0]['Tekst (imp)']
    assert.doesNotMatch(tekst, /\b_id:/)
    assert.doesNotMatch(tekst, /\bprice:/)
    assert.doesNotMatch(tekst, /\bdescription:/)
    assert.doesNotMatch(tekst, /\bactive:/)
  })

  test('product with only standard fields produces no extra key:value pairs in Tekst', async () => {
    const csv = []
    const invoice = makeExtraInvoice({
      itemsFromCart: [{ _id: 'p1', name: 'Bare Standard', price: 100, description: 'x', active: true }],
    })
    await handleExtraInvoice([invoice], makeExtraDeps(csv))
    assert.match(csv[0]['Tekst (imp)'], /Bare Standard/)
    // no "key: value" pairs from non-standard fields
    assert.doesNotMatch(csv[0]['Tekst (imp)'], /\w+: \w+/)
  })

  test('Header Info uses schoolInfo value when present', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv[0]['Header Info'], 'Kontakt skolen for spørsmål')
  })

  test('Header Info falls back when schoolInfo has no xledgerInvoiceHeaderInfo', async () => {
    const csv = []
    const deps = {
      ...makeExtraDeps(csv),
      schoolInfoList: [{ orgNr: 974568098, xledgerSchoolProductNumber: '9999001', xledgerInvoiceCustomString: '999' }],
    }
    await handleExtraInvoice([makeExtraInvoice()], deps)
    assert.equal(csv[0]['Header Info'], 'Spørsmål vedrørende faktura, ta kontakt med skolen din')
  })

  test('Ready To Invoice is always 1', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    for (const row of csv) {
      assert.equal(row['Ready To Invoice'], '1')
    }
  })

  test('passes extraInvoice type to generateInvoiceImportFile', async () => {
    let capturedType
    const deps = {
      ...makeExtraDeps([]),
      generateInvoiceImportFile: async (type) => { capturedType = type; return {} },
    }
    await handleExtraInvoice([makeExtraInvoice()], deps)
    assert.equal(capturedType, 'extraInvoice')
  })

  test('returns the result of generateInvoiceImportFile', async () => {
    const deps = {
      ...makeExtraDeps([]),
      generateInvoiceImportFile: async () => ({ status: 200, body: 'ok' }),
    }
    const result = await handleExtraInvoice([makeExtraInvoice()], deps)
    assert.deepEqual(result, { status: 200, body: 'ok' })
  })

  test('processes multiple invoices', async () => {
    const csv = []
    const inv1 = makeExtraInvoice({ _id: 'i1', itemsFromCart: [{ _id: 'p1', name: 'A', price: 100, active: true }] })
    const inv2 = makeExtraInvoice({ _id: 'i2', itemsFromCart: [{ _id: 'p2', name: 'B', price: 200, active: true }, { _id: 'p3', name: 'C', price: 300, active: true }] })
    await handleExtraInvoice([inv1, inv2], makeExtraDeps(csv))
    assert.equal(csv.length, 3)
  })

  test('fixed fields: Quantity, End Of Line, ImpSystem, Owner ID', async () => {
    const csv = []
    await handleExtraInvoice([makeExtraInvoice()], makeExtraDeps(csv))
    assert.equal(csv[0].Quantity, '1')
    assert.equal(csv[0]['End Of Line'], 'X')
    assert.equal(csv[0]['ImpSystem'], 'Skoleutvikling - JOTNE')
    assert.equal(csv[0]['Owner ID/Entity Code'], '39006')
  })
})
