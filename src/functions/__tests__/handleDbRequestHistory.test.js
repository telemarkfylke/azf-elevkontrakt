'use strict'

// PUT handleDbRequest with target-collection: history (Registrer innbetaling).
// queryMongoDB and validateRoles are stubbed with the same return shapes as the real ones.

const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const stub = (relative, exports) => {
  const file = require.resolve(path.join(__dirname, '..', '..', '..', relative))
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}

const state = {}
const reset = () => {
  state.roles = ['elevkontrakt.administrator-readwrite']
  state.document = { _id: '68c6e60ec799944753067ced', elevInfo: { fnr: '12345678901' }, unSignedskjemaInfo: { kontraktType: 'Leieavtale' }, fakturaInfo: { rate1: { status: 'Overført inkasso', sum: '1359' } } }
  state.updateResult = { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
  state.liveUpdated = 0
  state.liveThrows = false
  state.calls = []
}
reset()

// Real shapes: getDocuments → { status: 200, result } | { status: 404, error }, updateDocument → UpdateResult | { status, error }.
stub('src/lib/jobs/queryMongoDB.js', {
  getDocuments: async (query, type) => {
    state.calls.push(['getDocuments', type])
    return state.document ? { status: 200, result: [state.document] } : { status: 404, error: 'Fant ingen dokumenter' }
  },
  updateDocument: async (...args) => { state.calls.push(['updateDocument', ...args]); return state.updateResult },
  updateInheritedRates: async (updates) => {
    state.calls.push(['updateInheritedRates', updates])
    if (state.liveThrows) throw new Error('db down')
    return state.liveUpdated
  }
})
stub('src/lib/auth/validateRoles.js', { validateRoles: (header, roles) => roles.some(role => state.roles.includes(role)) })

let handler
const functions = require('@azure/functions')
const originalHttp = functions.app.http
functions.app.http = (name, options) => { if (name === 'handleDbRequest') handler = options.handler }
require('../handleDbRequest.js')
functions.app.http = originalHttp

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ upn: 'admin@telemarkfylke.no', roles: [] })}.sig`
const put = (body, { mock = false } = {}) => handler({
  method: 'PUT',
  headers: new Map([['authorization', `Bearer ${token}`], ['target-collection', 'history']]),
  query: new URLSearchParams(`isMock=${mock}`),
  json: async () => body
}, {})

const ID = '68c6e60ec799944753067ced'
const ISO = '2026-10-08T00:00:00.000Z'
const payment = (extra = {}) => ({
  contractID: ID,
  updateData: true,
  data: { 'fakturaInfo.rate1.betaltBeløp': '600', 'fakturaInfo.rate1.sistInnbetaltDato': ISO },
  expected: { 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': null },
  ...extra
})

describe('handleDbRequest PUT history', () => {
  beforeEach(reset)

  test('saves to history with a server-made change log and the lock filter', async () => {
    const response = await put(payment())
    assert.equal(response.status, 200)
    const [, id, updateData, type, filter] = state.calls.find(call => call[0] === 'updateDocument')
    assert.equal(id, ID)
    assert.equal(type, 'historyWithChangeLog')
    assert.deepEqual(filter, { 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': null })
    assert.equal(updateData.changeLog[0].changedBy, 'admin@telemarkfylke.no')
    assert.equal(response.jsonBody.liveUpdated, 0)
    assert.equal(response.jsonBody.liveError, false)
  })

  test('ignores a changeLog sent by the client', async () => {
    await put(payment({ changeLog: [{ changedBy: 'someone.else' }] }))
    const [, , updateData] = state.calls.find(call => call[0] === 'updateDocument')
    assert.equal(updateData.changeLog.length, 2)
    assert.ok(updateData.changeLog.every(entry => entry.changedBy === 'admin@telemarkfylke.no'))
  })

  test('also updates live copies and reports how many', async () => {
    state.liveUpdated = 1
    const response = await put(payment())
    assert.equal(response.jsonBody.liveUpdated, 1)
    const [, updates] = state.calls.find(call => call[0] === 'updateInheritedRates')
    assert.equal(updates[0].filter['elevInfo.fnr'], '12345678901')
  })

  test('a failing live update keeps the saved history edit and reports it', async () => {
    state.liveThrows = true
    const response = await put(payment())
    assert.equal(response.status, 200)
    assert.equal(response.jsonBody.liveError, true)
  })

  test('403 for non-administrators', async () => {
    state.roles = ['elevkontrakt.skoleadministrator-write']
    assert.equal((await put(payment())).status, 403)
  })

  test('400 in mock mode', async () => {
    assert.equal((await put(payment(), { mock: true })).status, 400)
  })

  test('400 for an invalid id or invalid data', async () => {
    assert.equal((await put(payment({ contractID: 'nope' }))).status, 400)
    assert.equal((await put(payment({ data: { 'fakturaInfo.rate1.sum': '0' } }))).status, 400)
  })

  test('404 when the contract is not in history', async () => {
    state.document = null
    assert.equal((await put(payment())).status, 404)
    assert.equal(state.calls.some(call => call[0] === 'updateDocument'), false)
  })

  test('409 when the page is out of date, and when the rate changed between read and write', async () => {
    assert.equal((await put(payment({ expected: { 'fakturaInfo.rate1.status': 'Overført inkasso', 'fakturaInfo.rate1.betaltBeløp': '100' } }))).status, 409)
    state.updateResult = { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
    assert.equal((await put(payment())).status, 409)
  })

  test('500, not 200, when updateDocument refuses', async () => {
    state.updateResult = { status: 400, error: 'Ugyldig documentType' }
    assert.equal((await put(payment())).status, 500)
  })
})
