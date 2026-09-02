'use strict'

const { test, describe, mock, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios').default
const {
  getAllStudents,
  getCompletedAssetRegistrations,
  getRecentlyCreatedAssetRegistrations
} = require('../queryPureservice.js')

afterEach(() => {
  mock.restoreAll()
})

describe('fetchAllPages (via getAllStudents) - "users"-shaped pages', () => {
  test('accumulates users and linked.emailaddresses across pages, stops on an empty page', async () => {
    const calledUrls = []
    mock.method(axios, 'get', async (url) => {
      calledUrls.push(url)
      if (url.includes('start=0')) {
        return {
          data: {
            users: [{ id: 1 }, { id: 2 }],
            linked: { emailaddresses: [{ userId: 1, email: 'a@skole.no' }, { userId: 2, email: 'b@skole.no' }] }
          }
        }
      }
      if (url.includes('start=500')) {
        return { data: { users: [{ id: 3 }], linked: { emailaddresses: [{ userId: 3, email: 'c@skole.no' }] } } }
      }
      return { data: { users: [] } }
    })

    const students = await getAllStudents()

    assert.deepEqual(students, [
      { pusId: 1, emails: ['a@skole.no'] },
      { pusId: 2, emails: ['b@skole.no'] },
      { pusId: 3, emails: ['c@skole.no'] }
    ])
    assert.equal(calledUrls.length, 3, 'expected 2 pages of data plus 1 empty page to stop on')
  })

  test('a student with no matching linked email gets an empty emails array', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) return { data: { users: [{ id: 99 }], linked: {} } }
      return { data: { users: [] } }
    })

    const students = await getAllStudents()

    assert.deepEqual(students, [{ pusId: 99, emails: [] }])
  })

  test('default sort=id is used (unchanged from before generalization)', async () => {
    const calledUrls = []
    mock.method(axios, 'get', async (url) => { calledUrls.push(url); return { data: { users: [] } } })

    await getAllStudents()

    assert.ok(calledUrls[0].includes('sort=id'))
  })
})

describe('fetchRecentAssetRegistrationPages (via getCompletedAssetRegistrations) - client-side date cutoff, no early exit', () => {
  // Comparing a DateTimeOffset field with `>` 400s no matter how the date is written (confirmed
  // live) - so there is deliberately no date clause in the filter. An earlier version also
  // sorted by `completed DESC` and stopped as soon as one out-of-window item was seen, assuming
  // that sort was honored - also disproven live (a 200-day lookback found zero results for a
  // reason known to have real completions in that window). So there is no early exit either:
  // every page is fetched (default sort=id, like fetchAllPages/getAllStudents), and the date
  // cutoff is applied to the full set afterward.

  test('builds the filter with completedReasonId only (no date clause), default sort=id', async () => {
    const calledUrls = []
    mock.method(axios, 'get', async (url) => { calledUrls.push(url); return { data: { assetregistrations: [] } } })

    await getCompletedAssetRegistrations({ completedReasonId: 14, sinceISO: '2026-08-01T00:00:00.000Z' })

    const url = decodeURIComponent(calledUrls[0])
    assert.ok(url.includes('completedReasonId == 14'))
    assert.ok(!url.includes('completed >'), 'no server-side date comparison - it 400s regardless of quoting')
    assert.ok(url.includes('include=asset'))
    assert.ok(calledUrls[0].includes('sort=id'), 'no dateField-based sort - it was never confirmed reliable, so nothing depends on it now')
  })

  test('keeps items completed after sinceISO, excludes ones at/before it, merges linked sub-collections', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) {
        return {
          data: {
            assetregistrations: [
              { id: 1, userId: 345, completed: '2026-08-15T00:00:00.000Z' },
              { id: 2, userId: 999, completed: '2026-07-01T00:00:00.000Z' } // at/before cutoff - excluded
            ],
            linked: { assets: [{ id: 8101, typeId: 3 }] }
          }
        }
      }
      return { data: { assetregistrations: [] } }
    })

    const result = await getCompletedAssetRegistrations({ completedReasonId: 11, sinceISO: '2026-08-01T00:00:00.000Z' })

    assert.deepEqual(result.assetregistrations.map(r => r.id), [1])
    assert.deepEqual(result.linked.assets, [{ id: 8101, typeId: 3 }])
  })

  test('does NOT stop early when an out-of-window item is seen mid-page - keeps paging to find later in-window items', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) {
        // an out-of-window item appears BEFORE an in-window one - would have wrongly triggered
        // early exit under the old sort-order-trusting design
        return { data: { assetregistrations: [{ id: 1, completed: '2026-07-01T00:00:00.000Z' }] } }
      }
      if (calls === 2) {
        return { data: { assetregistrations: [{ id: 2, completed: '2026-08-15T00:00:00.000Z' }] } }
      }
      return { data: { assetregistrations: [] } }
    })

    const result = await getCompletedAssetRegistrations({ completedReasonId: 11, sinceISO: '2026-08-01T00:00:00.000Z' })

    assert.deepEqual(result.assetregistrations.map(r => r.id), [2])
    assert.equal(calls, 3, 'must page all the way to the empty page, not stop after the first out-of-window item')
  })

  test('stops only on a genuinely empty page', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) return { data: { assetregistrations: [{ id: 1, completed: '2026-08-15T00:00:00.000Z' }] } }
      return { data: { assetregistrations: [] } }
    })

    await getCompletedAssetRegistrations({ completedReasonId: 11, sinceISO: '2026-08-01T00:00:00.000Z' })

    assert.equal(calls, 2)
  })
})

describe('getRecentlyCreatedAssetRegistrations - client-side date cutoff, no early exit', () => {
  test('sends no filter at all (only include=asset), default sort=id', async () => {
    const calledUrls = []
    mock.method(axios, 'get', async (url) => { calledUrls.push(url); return { data: { assetregistrations: [] } } })

    await getRecentlyCreatedAssetRegistrations({ sinceISO: '2026-08-28T00:00:00.000Z' })

    const url = decodeURIComponent(calledUrls[0])
    assert.ok(!url.includes('filter='))
    assert.ok(url.includes('include=asset'))
    assert.ok(calledUrls[0].includes('sort=id'))
  })

  test('keeps items created after sinceISO and excludes older ones', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) {
        return {
          data: {
            assetregistrations: [
              { id: 1, created: '2026-08-30T00:00:00.000Z', completed: null },
              { id: 2, created: '2026-08-20T00:00:00.000Z', completed: null } // before cutoff
            ]
          }
        }
      }
      return { data: { assetregistrations: [] } }
    })

    const result = await getRecentlyCreatedAssetRegistrations({ sinceISO: '2026-08-28T00:00:00.000Z' })

    assert.deepEqual(result.assetregistrations.map(r => r.id), [1])
  })

  test('returns both active and completed registrations within the window - caller filters completed === null itself', async () => {
    let calls = 0
    mock.method(axios, 'get', async () => {
      calls++
      if (calls === 1) {
        return {
          data: {
            assetregistrations: [
              { id: 1, created: '2026-08-30T00:00:00.000Z', completed: null },
              { id: 2, created: '2026-08-29T00:00:00.000Z', completed: '2026-08-29T00:00:00.000Z' }
            ]
          }
        }
      }
      return { data: { assetregistrations: [] } }
    })

    const result = await getRecentlyCreatedAssetRegistrations({ sinceISO: '2026-08-28T00:00:00.000Z' })

    assert.equal(result.assetregistrations.length, 2)
  })
})
