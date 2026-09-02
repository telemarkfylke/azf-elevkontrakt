'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { classifyPcPossession, getPcPossessionStatus } = require('../pureserviceAssetLifecycle.js')

const CONFIG = { pcAssetTypeIds: [3], returnedReasonIds: [11], boughtOutReasonIds: [22] }

const makeRegistration = (overrides = {}) => ({
  id: 1,
  userId: 345,
  assetId: 8101,
  assetRegistrationTypeId: 5,
  status: 1,
  created: '2026-06-10T00:00:00Z',
  createdById: 7,
  completed: null,
  completedReasonId: null,
  completedById: 2018,
  ...overrides
})

const makeAsset = (overrides = {}) => ({
  id: 8101,
  typeId: 3,
  uniqueId: 'PF4WZKRP',
  ...overrides
})

describe('classifyPcPossession', () => {
  test('no PC-type registrations -> never', () => {
    const result = classifyPcPossession([makeRegistration({ assetId: 999 })], [makeAsset({ id: 999, typeId: 7 })], CONFIG)
    assert.deepEqual(result, { status: 'never' })
  })

  test('empty registrations -> never', () => {
    const result = classifyPcPossession([], [], CONFIG)
    assert.deepEqual(result, { status: 'never' })
  })

  test('registration with completed === null -> has', () => {
    const registrations = [makeRegistration({ completed: null, createdById: 7 })]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'has')
    assert.equal(result.assetId, 8101)
    assert.equal(result.uniqueId, 'PF4WZKRP')
    assert.equal(result.since, '2026-06-10T00:00:00Z')
    assert.equal(result.createdById, 7, 'createdById is passed through so the caller can resolve who registered the handout')
  })

  test('completed registration with a returned reason -> returned', () => {
    const registrations = [makeRegistration({ completed: '2026-08-06T07:27:01Z', completedReasonId: 11, completedById: 2018 })]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'returned')
    assert.equal(result.completedReasonId, 11)
    assert.equal(result.completedById, 2018, 'completedById is passed through so the caller can resolve who completed the registration')
  })

  test('completed registration with a bought-out reason -> boughtOut', () => {
    const registrations = [makeRegistration({ completed: '2026-08-06T07:27:01Z', completedReasonId: 22, completedById: 5654 })]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'boughtOut')
    assert.equal(result.completedReasonId, 22)
    assert.equal(result.completedById, 5654)
  })

  test('completed registration with an unmapped reason -> unknown', () => {
    const registrations = [makeRegistration({ completed: '2026-08-06T07:27:01Z', completedReasonId: 99 })]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'unknown')
    assert.equal(result.completedReasonId, 99)
  })

  test('non-PC asset types are ignored even if other registrations exist', () => {
    const registrations = [
      makeRegistration({ id: 1, assetId: 8101, completed: null }),
      makeRegistration({ id: 2, assetId: 8102, completed: null })
    ]
    const assets = [makeAsset({ id: 8101, typeId: 3 }), makeAsset({ id: 8102, typeId: 9 })]
    const result = classifyPcPossession(registrations, assets, CONFIG)
    assert.equal(result.status, 'has')
    assert.equal(result.assetId, 8101)
  })

  test('multiple concurrent PC registrations - active one wins over completed ones', () => {
    const registrations = [
      makeRegistration({ id: 1, assetId: 8101, created: '2025-01-01T00:00:00Z', completed: '2025-06-01T00:00:00Z', completedReasonId: 11 }),
      makeRegistration({ id: 2, assetId: 8101, created: '2026-06-10T00:00:00Z', completed: null })
    ]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'has')
  })

  test('multiple completed PC registrations - most recently created one determines the outcome', () => {
    const registrations = [
      makeRegistration({ id: 1, assetId: 8101, created: '2024-01-01T00:00:00Z', completed: '2024-06-01T00:00:00Z', completedReasonId: 22 }),
      makeRegistration({ id: 2, assetId: 8101, created: '2026-01-01T00:00:00Z', completed: '2026-06-01T00:00:00Z', completedReasonId: 11 })
    ]
    const result = classifyPcPossession(registrations, [makeAsset()], CONFIG)
    assert.equal(result.status, 'returned')
  })

  test('module default PC_ASSET_TYPE_IDS (confirmed [3]) is used when no config is passed', () => {
    const registrations = [makeRegistration({ completed: null })]
    const result = classifyPcPossession(registrations, [makeAsset()])
    assert.equal(result.status, 'has')
  })

  test('module default RETURNED_REASON_IDS ([11]) is used when no config is passed', () => {
    const registrations = [makeRegistration({ completed: '2026-08-06T07:27:01Z', completedReasonId: 11 })]
    const result = classifyPcPossession(registrations, [makeAsset()])
    assert.equal(result.status, 'returned')
  })

  test('module default BOUGHT_OUT_REASON_IDS ([14], "Privatisering") is used when no config is passed', () => {
    const registrations = [makeRegistration({ completed: '2026-08-26T08:29:18Z', completedReasonId: 14 })]
    const result = classifyPcPossession(registrations, [makeAsset()])
    assert.equal(result.status, 'boughtOut')
  })

  test('a completedReasonId not in either module default map still falls back to unknown', () => {
    const registrations = [makeRegistration({ completed: '2026-08-06T07:27:01Z', completedReasonId: 77 })]
    const result = classifyPcPossession(registrations, [makeAsset()])
    assert.equal(result.status, 'unknown')
  })
})

describe('getPcPossessionStatus', () => {
  test('passes the linked assets and config through to classifyPcPossession', async () => {
    const deps = {
      getAssetRegistrationsFn: async (pusId) => ({
        assetregistrations: [makeRegistration({ completed: null })],
        linked: { assets: [makeAsset()] }
      }),
      config: CONFIG
    }
    const result = await getPcPossessionStatus(345, deps)
    assert.equal(result.status, 'has')
  })

  test('without an explicit config, falls back to the confirmed module defaults', async () => {
    const deps = {
      getAssetRegistrationsFn: async () => ({
        assetregistrations: [makeRegistration({ completed: '2026-08-26T08:29:18Z', completedReasonId: 14 })],
        linked: { assets: [makeAsset()] }
      })
    }
    const result = await getPcPossessionStatus(345, deps)
    assert.equal(result.status, 'boughtOut')
  })

  test('handles a response with no registrations at all', async () => {
    const deps = { getAssetRegistrationsFn: async () => ({ assetregistrations: [], linked: {} }) }
    const result = await getPcPossessionStatus(345, deps)
    assert.deepEqual(result, { status: 'never' })
  })
})
