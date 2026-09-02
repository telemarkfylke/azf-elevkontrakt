'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  syncPureserviceAssetLifecycle,
  resolveActorEmail,
  handleReleased,
  handleReturned,
  handleBoughtOut
} = require('../syncPureserviceAssetLifecycle.js')

// ---- Helpers ---------------------------------------------------------------

const makeContract = (overrides = {}) => ({
  _id: { toString: () => 'contract-id-1' },
  pureserviceId: 345,
  pcInfo: {},
  fakturaInfo: {
    rate1: { status: 'Ikke Fakturert', faktureringsår: 2024 },
    rate2: { status: 'Ikke Fakturert', faktureringsår: 2025 },
    rate3: { status: 'Ikke Fakturert', faktureringsår: 2026 }
  },
  elevInfo: { fnr: '11111111111', klasse: '1STA' },
  ...overrides
})

const PRICE_LIST = {
  prices: { regularPrice: '1500', reducedPrice: '0' },
  exceptionsFromRegularPrices: { students: [], classes: [] }
}

// =====================================================================
// resolveActorEmail
// =====================================================================

describe('resolveActorEmail', () => {
  test('resolves the email from linked.emailaddresses', async () => {
    const deps = { getUserFn: async () => ({ linked: { emailaddresses: [{ email: 'agent@pureservice.no' }] } }) }
    const email = await resolveActorEmail(2018, deps)
    assert.equal(email, 'agent@pureservice.no')
  })

  test('falls back to a labeled sentinel when getUserFn throws', async () => {
    const deps = { getUserFn: async () => { throw new Error('network error') } }
    const email = await resolveActorEmail(2018, deps)
    assert.equal(email, 'pureservice-agent-2018')
  })

  test('falls back to a labeled sentinel when no email is found in the response', async () => {
    const deps = { getUserFn: async () => ({ linked: {} }) }
    const email = await resolveActorEmail(2018, deps)
    assert.equal(email, 'pureservice-agent-2018')
  })
})

// =====================================================================
// handleReleased / handleReturned - identical shape, tested together
// =====================================================================

describe('handleReleased', () => {
  test('writes pcInfo.released when not yet marked', async () => {
    let captured
    const deps = { updateContractPCStatusFn: async (c) => { captured = c; return {} } }
    const result = await handleReleased(makeContract(), 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(captured.releasePC, 'true')
    assert.equal(captured.upn, 'agent@pureservice.no')
    assert.deepEqual(result, { action: 'release', contractId: 'contract-id-1', actorEmail: 'agent@pureservice.no' })
  })

  test('skips (no write) when already marked released', async () => {
    let called = false
    const deps = { updateContractPCStatusFn: async () => { called = true } }
    const result = await handleReleased(makeContract({ pcInfo: { released: 'true' } }), 'regular', 'x', false, deps)

    assert.equal(called, false)
    assert.equal(result, null)
  })

  test('dry-run: no write, still returns the preview action', async () => {
    let called = false
    const deps = { updateContractPCStatusFn: async () => { called = true } }
    const result = await handleReleased(makeContract(), 'regular', 'agent@pureservice.no', true, deps)

    assert.equal(called, false)
    assert.deepEqual(result, { action: 'release', contractId: 'contract-id-1', actorEmail: 'agent@pureservice.no' })
  })
})

describe('handleReturned', () => {
  test('writes pcInfo.returned when not yet marked', async () => {
    let captured
    const deps = { updateContractPCStatusFn: async (c) => { captured = c; return {} } }
    await handleReturned(makeContract(), 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(captured.returnPC, 'true')
  })

  test('skips when already marked returned', async () => {
    let called = false
    const deps = { updateContractPCStatusFn: async () => { called = true } }
    const result = await handleReturned(makeContract({ pcInfo: { returned: 'true' } }), 'regular', 'x', false, deps)

    assert.equal(called, false)
    assert.equal(result, null)
  })
})

// =====================================================================
// handleBoughtOut - pcInfo write + always-attempt invoicing
// =====================================================================

describe('handleBoughtOut', () => {
  test('writes pcInfo.boughtOut and creates an invoice for all unpaid rates', async () => {
    let statusCall, invoiceCall
    const deps = {
      updateContractPCStatusFn: async (c) => { statusCall = c; return {} },
      getThisYearsPriceListFn: async () => PRICE_LIST,
      createBuyOutInvoiceFn: async (contract, items, docType, createdBy) => { invoiceCall = { contract, items, docType, createdBy }; return { status: 200 } }
    }

    const actions = await handleBoughtOut(makeContract(), 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(statusCall.buyOutPC, 'true')
    assert.equal(invoiceCall.items.length, 3)
    assert.ok(invoiceCall.items.every(item => item.sum === '1500'))
    assert.equal(invoiceCall.docType, 'regular')
    assert.equal(invoiceCall.createdBy.email, 'agent@pureservice.no')
    assert.equal(actions.length, 2)
    assert.equal(actions[0].action, 'boughtOut')
    assert.equal(actions[1].action, 'buyOutInvoice')
    assert.equal(actions[1].total, 4500)
  })

  test('a reduced-price student gets the reduced price on every line', async () => {
    const priceList = { ...PRICE_LIST, exceptionsFromRegularPrices: { students: [{ fnr: '11111111111' }], classes: [] } }
    let invoiceItems
    const deps = {
      updateContractPCStatusFn: async () => ({}),
      getThisYearsPriceListFn: async () => priceList,
      createBuyOutInvoiceFn: async (c, items) => { invoiceItems = items; return { status: 200 } }
    }

    await handleBoughtOut(makeContract(), 'regular', 'agent@pureservice.no', false, deps)

    assert.ok(invoiceItems.every(item => item.sum === '0'))
  })

  test('self-healing: already marked boughtOut, but a rate is still unpaid - retries invoicing without re-writing pcInfo', async () => {
    let statusCalled = false
    let invoiceCalled = false
    const deps = {
      updateContractPCStatusFn: async () => { statusCalled = true },
      getThisYearsPriceListFn: async () => PRICE_LIST,
      createBuyOutInvoiceFn: async () => { invoiceCalled = true; return { status: 200 } }
    }

    const actions = await handleBoughtOut(makeContract({ pcInfo: { boughtOut: 'true' } }), 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(statusCalled, false, 'pcInfo write should not repeat once already marked')
    assert.equal(invoiceCalled, true, 'invoicing should still be attempted')
    assert.equal(actions.length, 1)
    assert.equal(actions[0].action, 'buyOutInvoice')
  })

  test('no invoice attempt when there are zero unpaid rates', async () => {
    const contract = makeContract({
      fakturaInfo: {
        rate1: { status: 'Fakturert - Utkjøp', faktureringsår: 2024 },
        rate2: { status: 'Utlån faktureres ikke', faktureringsår: 2025 },
        rate3: { status: 'Betalt', faktureringsår: 2026 }
      }
    })
    let invoiceCalled = false
    const deps = {
      updateContractPCStatusFn: async () => ({}),
      getThisYearsPriceListFn: async () => PRICE_LIST,
      createBuyOutInvoiceFn: async () => { invoiceCalled = true; return { status: 200 } }
    }

    const actions = await handleBoughtOut(contract, 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(invoiceCalled, false)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].action, 'boughtOut')
  })

  test('a failed createBuyOutInvoice does not add a buyOutInvoice action (so the caller does not think it succeeded)', async () => {
    const deps = {
      updateContractPCStatusFn: async () => ({}),
      getThisYearsPriceListFn: async () => PRICE_LIST,
      createBuyOutInvoiceFn: async () => ({ status: 404, body: 'no rates found' })
    }

    const actions = await handleBoughtOut(makeContract(), 'regular', 'agent@pureservice.no', false, deps)

    assert.equal(actions.some(a => a.action === 'buyOutInvoice'), false)
  })

  test('dry-run: no write calls at all, but the preview includes the computed invoice items/total', async () => {
    let statusCalled = false
    let invoiceCalled = false
    const deps = {
      updateContractPCStatusFn: async () => { statusCalled = true },
      getThisYearsPriceListFn: async () => PRICE_LIST,
      createBuyOutInvoiceFn: async () => { invoiceCalled = true; return { status: 200 } }
    }

    const actions = await handleBoughtOut(makeContract(), 'regular', 'agent@pureservice.no', true, deps)

    assert.equal(statusCalled, false)
    assert.equal(invoiceCalled, false)
    assert.equal(actions.length, 2)
    assert.equal(actions[1].action, 'buyOutInvoice')
    assert.equal(actions[1].items.length, 3)
    assert.equal(actions[1].total, 4500)
  })
})

// =====================================================================
// syncPureserviceAssetLifecycle - orchestration
// =====================================================================

describe('syncPureserviceAssetLifecycle', () => {
  const makeAsset = (id = 8101) => ({ id, typeId: 3 })

  const makeDeps = (overrides = {}) => ({
    getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
      if (completedReasonId === 11) return { assetregistrations: [], linked: {} }
      if (completedReasonId === 14) return { assetregistrations: [], linked: {} }
      return { assetregistrations: [], linked: {} }
    },
    getRecentlyCreatedAssetRegistrationsFn: async () => ({ assetregistrations: [], linked: {} }),
    getDocumentsFn: async (query) => {
      // Bulk pre-filter query ({ $in }) - default: everyone still needs work
      if (query.pureserviceId?.$in) {
        return { status: 200, result: query.pureserviceId.$in.map(pureserviceId => ({ pureserviceId })) }
      }
      // Single-user lookup (findContractByPureserviceId)
      return { status: 200, result: [makeContract({ pureserviceId: query.pureserviceId })] }
    },
    getPcPossessionStatusFn: async () => ({ status: 'never' }),
    resolveActorEmailFn: async () => 'agent@pureservice.no',
    ...overrides
  })

  test('discovers a returned user, dispatches to handleReturned via the authoritative status', async () => {
    let returnCall
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getPcPossessionStatusFn: async () => ({ status: 'returned', completedById: 2018 }),
      handleReturnedFn: async (contract, docType, actorEmail) => { returnCall = { contract, docType, actorEmail }; return { action: 'return' } }
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(returnCall.actorEmail, 'agent@pureservice.no')
    assert.equal(summary.returned.length, 1)
  })

  test('a user surfaced by more than one discovery query is only processed once', async () => {
    let callCount = 0
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        if (completedReasonId === 14) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getPcPossessionStatusFn: async () => { callCount++; return { status: 'returned', completedById: 2018 } }
    })

    await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(callCount, 1)
  })

  test('status "never"/"unknown" candidates are skipped, not dispatched anywhere', async () => {
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getPcPossessionStatusFn: async () => ({ status: 'unknown', completedById: 2018 })
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(summary.returned.length, 0)
    assert.equal(summary.boughtOut.length, 0)
    assert.equal(summary.released.length, 0)
    assert.equal(summary.skipped.some(s => s.userId === 345 && s.reason === 'unknown'), true)
  })

  test('pureserviceId option bypasses discovery entirely and processes only that user', async () => {
    let discoveryCalled = false
    let checkedUserId
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async () => { discoveryCalled = true; return { assetregistrations: [], linked: {} } },
      getRecentlyCreatedAssetRegistrationsFn: async () => { discoveryCalled = true; return { assetregistrations: [], linked: {} } },
      getPcPossessionStatusFn: async (userId) => { checkedUserId = userId; return { status: 'returned', completedById: 2018 } }
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true, pureserviceId: 345 })

    assert.equal(discoveryCalled, false, 'discovery calls should be skipped entirely when targeting a single user')
    assert.equal(checkedUserId, 345)
    assert.equal(summary.returned.length, 1)
  })

  test('pureserviceId targeting still goes through the normal pre-filter-free idempotency check in the handler', async () => {
    const deps = makeDeps({
      getDocumentsFn: async (query) => {
        if (query.pureserviceId?.$in) return { status: 200, result: [] }
        return { status: 200, result: [makeContract({ pcInfo: { returned: 'true' } })] }
      },
      getPcPossessionStatusFn: async () => ({ status: 'returned', completedById: 2018 })
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true, pureserviceId: 345 })

    assert.equal(summary.returned.length, 0, 'already-returned contract should be skipped, not re-reported as an action')
    assert.ok(summary.skipped.some(s => s.userId === 345 && s.reason === 'already-returned'))
  })

  test('a candidate with no matching contract is skipped, not thrown', async () => {
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) return { assetregistrations: [{ userId: 999, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getDocumentsFn: async (query) => {
        if (query.pureserviceId?.$in) return { status: 200, result: query.pureserviceId.$in.map(pureserviceId => ({ pureserviceId })) }
        return { status: 404, error: 'Fant ingen dokumenter' }
      },
      getPcPossessionStatusFn: async () => ({ status: 'returned', completedById: 2018 })
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(summary.errors.length, 0)
    assert.ok(summary.skipped.some(s => s.userId === 999 && s.reason === 'no-contract'))
  })

  test('a per-user error is isolated - other candidates still get processed', async () => {
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) {
          return {
            assetregistrations: [{ userId: 1, assetId: 8101 }, { userId: 2, assetId: 8101 }],
            linked: { assets: [makeAsset()] }
          }
        }
        return { assetregistrations: [], linked: {} }
      },
      getPcPossessionStatusFn: async (userId) => {
        if (userId === 1) throw new Error('Pureservice blew up')
        return { status: 'returned', completedById: 2018 }
      }
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(summary.errors.length, 1)
    assert.equal(summary.errors[0].userId, 1)
    assert.equal(summary.returned.length, 1, 'user 2 should still be processed despite user 1 erroring')
  })

  test('the pre-filter excludes a candidate whose contract already has the target flag set', async () => {
    let possessionCheckCount = 0
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 11) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getDocumentsFn: async (query) => {
        // Bulk pre-filter: nobody matches (already handled) - simulates pcInfo.returned already 'true'
        if (query.pureserviceId?.$in) return { status: 200, result: [] }
        return { status: 200, result: [makeContract()] }
      },
      getPcPossessionStatusFn: async () => { possessionCheckCount++; return { status: 'returned', completedById: 2018 } }
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(possessionCheckCount, 0, 'pre-filtered-out candidates should never reach the Pureservice possession check')
    assert.equal(summary.returned.length, 0)
  })

  test('dry-run mode makes zero write calls across the whole run', async () => {
    let writeCalled = false
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ completedReasonId }) => {
        if (completedReasonId === 14) return { assetregistrations: [{ userId: 345, assetId: 8101 }], linked: { assets: [makeAsset()] } }
        return { assetregistrations: [], linked: {} }
      },
      getPcPossessionStatusFn: async () => ({ status: 'boughtOut', completedById: 2018 }),
      updateContractPCStatusFn: async () => { writeCalled = true },
      createBuyOutInvoiceFn: async () => { writeCalled = true; return { status: 200 } },
      getThisYearsPriceListFn: async () => PRICE_LIST
    })

    const summary = await syncPureserviceAssetLifecycle(deps, { dryRun: true })

    assert.equal(writeCalled, false)
    assert.equal(summary.dryRun, true)
    assert.equal(summary.boughtOut.length, 2, 'boughtOut pcInfo preview + buyOutInvoice preview')
  })

  test('lookbackDays option changes the sinceISO passed to the discovery calls', async () => {
    const sinceValues = []
    const deps = makeDeps({
      getCompletedAssetRegistrationsFn: async ({ sinceISO }) => { sinceValues.push(sinceISO); return { assetregistrations: [], linked: {} } },
      getRecentlyCreatedAssetRegistrationsFn: async ({ sinceISO }) => { sinceValues.push(sinceISO); return { assetregistrations: [], linked: {} } }
    })

    const shortRun = await syncPureserviceAssetLifecycle(deps, { dryRun: true, lookbackDays: 1 })
    sinceValues.length = 0
    const longRun = await syncPureserviceAssetLifecycle(deps, { dryRun: true, lookbackDays: 365 })

    assert.ok(new Date(sinceValues[0]).getTime() < new Date().getTime() - 300 * 24 * 60 * 60 * 1000, 'a 365-day lookback should produce a sinceISO well over 300 days in the past')
    assert.ok(shortRun && longRun, 'both runs complete without error regardless of window size')
  })
})
