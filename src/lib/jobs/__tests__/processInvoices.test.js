'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { generateInvoices } = require('../processInvoices.js')

// ---- Helpers ---------------------------------------------------------------

const makeContract = (overrides = {}) => ({
  _id: 'contract-id-1',
  fakturaInfo: {
    rate1: { status: 'Ikke Fakturert', faktureringsår: 2024 },
    rate2: { status: 'Ikke Fakturert', faktureringsår: 2025 },
    rate3: { status: 'Ikke Fakturert', faktureringsår: 2026 },
  },
  ansvarligInfo: { fnr: '11111111111' },
  elevInfo: { navn: 'Test Elev', fnr: '22222222222' },
  skoleOrgNr: '974568098',
  ...overrides,
})

const makeBody = (overrides = {}) => ({
  customerId: '507f1f77bcf86cd799439011',
  mainDocumentCollectionSource: 'regular',
  cart: { buyOut: [], extraInvoice: [] },
  userInfo: {
    displayName: 'Test User',
    givenName: 'Test',
    surname: 'User',
    userPrincipalName: 'test@example.com',
    companyName: 'TFK',
    officeLocation: 'Skien',
    jobTitle: 'Admin',
  },
  ...overrides,
})

const makeRequest = () => ({ method: 'POST' })

const makeDeps = ({ contract, pendingExtraInvoices = [], postedInvoices = [], updates = [] } = {}) => {
  let serialCounter = 0
  return {
    getDocuments: async (query, collectionType) => {
      if (collectionType === 'invoices') {
        return { status: 200, result: pendingExtraInvoices }
      }
      return { status: 200, result: contract ? [contract] : [] }
    },
    updateDocument: async (id, data, type) => { updates.push({ id, data, type }); return { status: 200 } },
    postExtraInvoice: async (invoice) => { postedInvoices.push(invoice); return { acknowledged: true } },
    generateSerialNumber: async () => `SN-${++serialCounter}`,
    logger: () => {},
  }
}

// =====================================================================
// extraInvoice creation - dedup guard (Fix C)
// =====================================================================

describe('generateInvoices - extraInvoice dedup guard', () => {
  test('creates a pending extraInvoice when none exists yet', async () => {
    const posted = []
    const body = makeBody({ cart: { buyOut: [], extraInvoice: [{ _id: 'p1', name: 'Mus', price: 250 }] } })
    const deps = makeDeps({ contract: makeContract(), postedInvoices: posted })

    const result = await generateInvoices(body, makeRequest(), deps)

    assert.equal(result.status, 200)
    assert.equal(posted.length, 1)
    assert.equal(posted[0].type, 'extraInvoice')
  })

  test('rejects with 409 when a pending extraInvoice already exists for the contract', async () => {
    const posted = []
    const body = makeBody({ cart: { buyOut: [], extraInvoice: [{ _id: 'p1', name: 'Mus', price: 250 }] } })
    const deps = makeDeps({
      contract: makeContract(),
      pendingExtraInvoices: [{ _id: 'existing-invoice', type: 'extraInvoice', status: 'Ikke Fakturert' }],
      postedInvoices: posted,
    })

    const result = await generateInvoices(body, makeRequest(), deps)

    assert.equal(result.status, 409)
    assert.equal(posted.length, 0, 'should not create a second pending invoice for the same contract')
  })
})

// =====================================================================
// extraInvoice creation - stable løpenummer (Fix A)
// =====================================================================

describe('generateInvoices - extraInvoice løpenummer persistence', () => {
  test('generates and persists a løpenummer on the invoice document at creation time', async () => {
    const posted = []
    const body = makeBody({ cart: { buyOut: [], extraInvoice: [{ _id: 'p1', name: 'Mus', price: 250 }] } })
    const deps = makeDeps({ contract: makeContract(), postedInvoices: posted })

    await generateInvoices(body, makeRequest(), deps)

    assert.ok(posted[0].løpenummer, 'løpenummer should be set on the invoice document at creation time')
  })

  test('two separate contracts each get their own distinct løpenummer', async () => {
    const posted = []
    const deps = makeDeps({ contract: makeContract(), postedInvoices: posted })
    const body1 = makeBody({ customerId: '507f1f77bcf86cd799439011', cart: { buyOut: [], extraInvoice: [{ _id: 'p1', name: 'A', price: 100 }] } })
    const body2 = makeBody({ customerId: '507f1f77bcf86cd799439012', cart: { buyOut: [], extraInvoice: [{ _id: 'p2', name: 'B', price: 200 }] } })

    await generateInvoices(body1, makeRequest(), deps)
    await generateInvoices(body2, makeRequest(), deps)

    assert.notEqual(posted[0].løpenummer, posted[1].løpenummer)
  })
})

// =====================================================================
// buyOut creation - regression check, unaffected by the extraInvoice fixes
// =====================================================================

describe('generateInvoices - buyOut (regression)', () => {
  test('creates a buyOut invoice and immediately flips the contract rate status', async () => {
    const posted = []
    const updates = []
    const contract = makeContract()
    const body = makeBody({ cart: { buyOut: [{ faktureringsår: 2024, sum: 4000 }], extraInvoice: [] } })
    const deps = makeDeps({ contract, postedInvoices: posted, updates })

    const result = await generateInvoices(body, makeRequest(), deps)

    assert.equal(result.status, 200)
    assert.equal(posted.length, 1)
    assert.equal(posted[0].type, 'buyOut')
    assert.ok(updates.some(u => u.data['fakturaInfo.rate1.status'] === 'Fakturert - Utkjøp'))
  })

  test('rejects a second buyOut request for the same rate once already invoiced', async () => {
    const posted = []
    const updates = []
    // Simulate the rate already having been flipped by a prior request
    const contract = makeContract({ fakturaInfo: { rate1: { status: 'Fakturert - Utkjøp', faktureringsår: 2024 } } })
    const body = makeBody({ cart: { buyOut: [{ faktureringsår: 2024, sum: 4000 }], extraInvoice: [] } })
    const deps = makeDeps({ contract, postedInvoices: posted, updates })

    const result = await generateInvoices(body, makeRequest(), deps)

    assert.equal(result.status, 404)
    assert.equal(posted.length, 0)
  })
})
