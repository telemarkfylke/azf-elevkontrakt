'use strict'

/**
 * The store holds the only copy of what a bulk run billed, but the run itself bills real money -
 * so the test that matters most is that a storage outage costs the copy and nothing else.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { createBulkRunStore, readRun, readProgress, listRuns, pruneExpiredRuns, RECENT_LIMIT } = require('../bulkRunStore.js')

// ---- Fixtures ----

const report = (overrides = {}) => ({
  runId: null,
  dryRun: false,
  mode: 'boughtOut',
  collections: ['regular'],
  fnrColumn: 'fnr',
  fileRowCount: 3,
  uniqueFnr: 3,
  candidateContracts: 3,
  invoiced: [],
  skipped: [],
  skippedRates: [],
  multiMatch: [],
  notFound: [],
  invalidRows: [],
  errors: [],
  totals: { contracts: 0, rates: 0, sum: 0 },
  fatal: null,
  reportBlob: null,
  ...overrides
})

const asStream = (payload) => ({
  readableStreamBody: (async function * () { yield Buffer.from(JSON.stringify(payload)) })()
})

/**
 * @param {Object} [options]
 * @param {Array} [options.blobs] - { name, metadata, lastModified, content }
 */
const fakeContainer = ({ exists = true, blobs = [], failUpload = false, failDeleteFor = [] } = {}) => {
  const calls = { creates: 0, uploads: [], downloads: [], deletes: [], listings: 0 }
  const client = {
    exists: async () => exists,
    createIfNotExists: async () => { calls.creates++; return {} },
    getBlockBlobClient: (name) => ({
      exists: async () => blobs.some(blob => blob.name === name),
      upload: async (content) => {
        if (failUpload) throw new Error('storage down')
        calls.uploads.push({ name, payload: JSON.parse(content) })
      },
      download: async () => {
        calls.downloads.push(name)
        const found = blobs.find(blob => blob.name === name)
        return asStream(found?.content ?? null)
      },
      delete: async () => {
        if (failDeleteFor.includes(name)) throw new Error('kunne ikke slette')
        calls.deletes.push(name)
      }
    }),
    listBlobsFlat: () => {
      calls.listings++
      return (async function * () {
        for (const blob of blobs) yield { name: blob.name, metadata: blob.metadata, properties: { lastModified: blob.lastModified } }
      })()
    }
  }
  return { calls, containerClientFn: () => client }
}

const at = (iso) => () => new Date(iso)

// =====================================================================================

describe('bulkRunStore - a storage failure never reaches the run', () => {
  test('write returns false rather than throwing', async () => {
    const { containerClientFn } = fakeContainer({ failUpload: true })
    const store = createBulkRunStore('run-1', { containerClientFn })

    const ok = await store.write('running', report())

    assert.equal(ok, false)
    assert.equal(store.state().persisted, false)
    assert.equal(store.state().failures, 1)
    assert.equal(store.state().error, 'storage down')
  })

  test('a missing connection string is a failed write, not a crash', async () => {
    // No AZURE_STORAGE_CONNECTION_STRING under node --test, so this is the real production
    // degradation path: fromConnectionString throws synchronously and must be caught like any other.
    const store = createBulkRunStore('run-1')

    assert.equal(await store.write('running', report()), false)
    assert.equal(store.state().persisted, false)
  })

  test('a report without totals still does not throw', async () => {
    const { containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn })

    assert.equal(await store.write('failed', { ...report(), totals: undefined }), true)
  })
})

describe('bulkRunStore - what gets stored', () => {
  test('the stored record keeps every bucket but drops reportBlob', async () => {
    const { calls, containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn, nowFn: at('2026-09-25T10:00:00Z') })

    await store.write('completed', report({ reportBlob: { persisted: true }, notFound: [{ fnr: '01010112345' }] }))

    const stored = calls.uploads[0].payload
    assert.equal(stored.runId, 'run-1')
    assert.equal(stored.status, 'completed')
    assert.deepEqual(stored.report.notFound, [{ fnr: '01010112345' }])
    assert.equal('reportBlob' in stored.report, false, 'circular and stale by one write - the envelope already says this')
  })

  test('the progress record carries counters and the feed, not the buckets', async () => {
    const { calls, containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn })
    store.setTotal(3)
    store.advance()
    store.note({ fnr: '01010112345', navn: 'Ola Nordmann', total: 1500 })

    await store.writeProgress('running', report({ invoiced: [{ total: 1500, rates: [] }] }))

    const stored = calls.uploads[0].payload
    assert.equal(calls.uploads[0].name, 'run-1.progress.json')
    assert.equal(stored.processed, 1)
    assert.equal(stored.total, 3)
    assert.equal(stored.tallies.invoiced, 1)
    assert.equal(stored.tallies.sum, 1500)
    assert.deepEqual(stored.recent, [{ fnr: '01010112345', navn: 'Ola Nordmann', total: 1500 }])
  })

  test('the feed keeps only the most recent entries', async () => {
    const { calls, containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn })
    for (let i = 0; i < RECENT_LIMIT + 5; i++) store.note({ fnr: String(i), navn: 'Elev ' + i, total: 100 })

    await store.writeProgress('running', report())

    const { recent } = calls.uploads[0].payload
    assert.equal(recent.length, RECENT_LIMIT)
    assert.equal(recent[0].navn, 'Elev 5', 'oldest dropped first')
    assert.equal(recent.at(-1).navn, 'Elev ' + (RECENT_LIMIT + 4))
  })

  test('the container is created once, not once per write', async () => {
    const { calls, containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn })

    for (let i = 0; i < 5; i++) await store.write('running', report())

    assert.equal(calls.uploads.length, 5)
    assert.equal(calls.creates, 1)
  })
})

describe('bulkRunStore - flush cadence', () => {
  test('tick writes at most once per window', async () => {
    let now = new Date('2026-09-25T10:00:00Z')
    const { calls, containerClientFn } = fakeContainer()
    const store = createBulkRunStore('run-1', { containerClientFn, nowFn: () => now, progressIntervalMs: 2000, fullIntervalMs: 30000 })

    await store.tick('running', report())
    const afterFirst = calls.uploads.length
    now = new Date('2026-09-25T10:00:01Z')
    await store.tick('running', report())

    assert.equal(calls.uploads.length, afterFirst, 'inside the window, nothing is written')

    now = new Date('2026-09-25T10:00:03Z')
    await store.tick('running', report())
    assert.equal(calls.uploads.filter(upload => upload.name.endsWith('.progress.json')).length, 2)
  })

  test('a failed write does not consume the window', async () => {
    let now = new Date('2026-09-25T10:00:00Z')
    const container = fakeContainer({ failUpload: true })
    const store = createBulkRunStore('run-1', { containerClientFn: container.containerClientFn, nowFn: () => now, progressIntervalMs: 2000 })

    await store.writeProgress('running', report())
    now = new Date('2026-09-25T10:00:00.500Z')

    // Still inside the window, but the last write never landed, so the next tick must retry rather
    // than wait out a window it never used.
    await store.tick('running', report())
    assert.equal(container.calls.uploads.length, 0, 'nothing landed')
    // 1 from the write above, then 2 from the tick: the retried progress write plus the first full one.
    assert.equal(store.state().failures, 3, 'the progress write was retried rather than skipped')
  })
})

describe('bulkRunStore - reading runs back', () => {
  test('an unknown runId is null rather than an error', async () => {
    const { containerClientFn } = fakeContainer({ blobs: [] })
    assert.equal(await readRun('nope', { containerClientFn }), null)
    assert.equal(await readProgress('nope', { containerClientFn }), null)
  })

  test('a missing container is null too', async () => {
    const { containerClientFn } = fakeContainer({ exists: false })
    assert.equal(await readRun('run-1', { containerClientFn }), null)
  })

  test('listRuns reads summaries from metadata without downloading any blob', async () => {
    const { calls, containerClientFn } = fakeContainer({
      blobs: [
        { name: 'run-old.json', lastModified: new Date('2026-09-01T09:00:00Z'), metadata: { runId: 'run-old', status: 'completed', startedAt: '2026-09-01T09:00:00Z', dryRun: 'false', mode: 'boughtOut', contracts: '10', rates: '20', sum: '15000' } },
        { name: 'run-new.json', lastModified: new Date('2026-09-25T09:00:00Z'), metadata: { runId: 'run-new', status: 'running', startedAt: '2026-09-25T09:00:00Z', dryRun: 'true', mode: 'oneTime', contracts: '1', rates: '1', sum: '1500' } },
        { name: 'run-new.progress.json', lastModified: new Date('2026-09-25T09:01:00Z'), metadata: {} }
      ]
    })

    const runs = await listRuns(25, { containerClientFn })

    assert.equal(calls.downloads.length, 0, 'the metadata is there precisely so listing costs one request')
    assert.equal(runs.length, 2, 'the progress blob is not a run')
    assert.deepEqual(runs.map(run => run.runId), ['run-new', 'run-old'], 'newest first')
    assert.equal(runs[0].dryRun, true)
    assert.deepEqual(runs[1].totals, { contracts: 10, rates: 20, sum: 15000 })
  })

  test('listRuns honours the limit', async () => {
    const blobs = Array.from({ length: 5 }, (unused, i) => ({
      name: `run-${i}.json`,
      lastModified: new Date(2026, 8, i + 1),
      metadata: { runId: `run-${i}`, status: 'completed', contracts: '0', rates: '0', sum: '0' }
    }))
    const { containerClientFn } = fakeContainer({ blobs })

    assert.equal((await listRuns(2, { containerClientFn })).length, 2)
  })
})

describe('bulkRunStore - retention', () => {
  const old = new Date('2026-01-01T00:00:00Z')
  const recent = new Date('2026-09-20T00:00:00Z')

  test('only blobs past the window are deleted, and both blobs of a run go', async () => {
    const { calls, containerClientFn } = fakeContainer({
      blobs: [
        { name: 'run-old.json', lastModified: old },
        { name: 'run-old.progress.json', lastModified: old },
        { name: 'run-recent.json', lastModified: recent }
      ]
    })

    const result = await pruneExpiredRuns(90, { containerClientFn, nowFn: at('2026-09-25T00:00:00Z') })

    assert.deepEqual(calls.deletes.sort(), ['run-old.json', 'run-old.progress.json'])
    assert.deepEqual(result, { deleted: 2, failed: 0 })
  })

  test('one blob that will not delete does not abort the sweep', async () => {
    const { calls, containerClientFn } = fakeContainer({
      blobs: [
        { name: 'run-a.json', lastModified: old },
        { name: 'run-b.json', lastModified: old }
      ],
      failDeleteFor: ['run-a.json']
    })

    const result = await pruneExpiredRuns(90, { containerClientFn, nowFn: at('2026-09-25T00:00:00Z') })

    assert.deepEqual(result, { deleted: 1, failed: 1 })
    assert.deepEqual(calls.deletes, ['run-b.json'])
  })

  test('a container that was never created is not an error', async () => {
    const { containerClientFn } = fakeContainer({ exists: false })
    assert.deepEqual(await pruneExpiredRuns(90, { containerClientFn }), { deleted: 0, failed: 0 })
  })
})
