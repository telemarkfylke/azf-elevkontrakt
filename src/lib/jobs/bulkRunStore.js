const { BlobServiceClient } = require('@azure/storage-blob')
const { logger } = require('@vtfk/logger')
const { storage, bulkInvoice } = require('../../../config')

const logPrefix = 'bulkRunStore'

const FULL_INTERVAL_MS = 30 * 1000
const PROGRESS_INTERVAL_MS = 2 * 1000
const RECENT_LIMIT = 20

const fullBlobName = (runId) => `${runId}.json`
const progressBlobName = (runId) => `${runId}.progress.json`

// Built lazily so this module can be required with no connection string set, as under node --test.
const getContainerClient = () => BlobServiceClient.fromConnectionString(storage.connectionString).getContainerClient(bulkInvoice.runContainer)

const uploadJson = async (containerClient, blobName, payload, metadata) => {
  const content = JSON.stringify(payload)
  await containerClient.getBlockBlobClient(blobName).upload(content, Buffer.byteLength(content), {
    overwrite: true,
    blobHTTPHeaders: { blobContentType: 'application/json' },
    ...(metadata ? { metadata } : {})
  })
}

const downloadJson = async (containerClient, blobName) => {
  const blobClient = containerClient.getBlockBlobClient(blobName)
  if (!await blobClient.exists()) return null
  const download = await blobClient.download()
  const chunks = []
  for await (const chunk of download.readableStreamBody) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

const talliesFrom = (report) => ({
  invoiced: report.invoiced.length,
  skipped: report.skipped.length,
  skippedRates: report.skippedRates.length,
  multiMatch: report.multiMatch.length,
  notFound: report.notFound.length,
  invalidRows: report.invalidRows.length,
  errors: report.errors.length,
  sum: report.invoiced.reduce((sum, entry) => sum + entry.total, 0)
})

// Metadata values must be ASCII strings, so only counts and the two enum-ish fields go here.
const metadataFrom = (runId, status, startedAt, report) => ({
  runId,
  status,
  startedAt,
  dryRun: String(report.dryRun),
  mode: report.mode ?? 'ukjent',
  contracts: String(report.totals?.contracts ?? 0),
  rates: String(report.totals?.rates ?? 0),
  sum: String(report.totals?.sum ?? 0)
})

/**
 * Per-run recorder for the bulk-invoicing report.
 *
 * Every method is non-throwing: the run bills real money, so a storage outage must cost the
 * report's copy, never a student's invoice. Failures are counted and surfaced through state().
 *
 * @param {String} runId
 * @param {Object} [deps]
 * @returns {Object}
 */
const createBulkRunStore = (runId, deps = {}) => {
  const {
    containerClientFn = getContainerClient,
    uploadFn = uploadJson,
    nowFn = () => new Date(),
    fullIntervalMs = FULL_INTERVAL_MS,
    progressIntervalMs = PROGRESS_INTERVAL_MS
  } = deps

  const startedAt = nowFn().toISOString()
  const recent = []
  let processed = 0
  let total = 0
  let lastFullAt = 0
  let lastProgressAt = 0
  let persisted = false
  let failures = 0
  let lastError = null
  let containerReady = null

  const ensureContainer = async (containerClient) => {
    // No access option - the container holds unmasked fnr and must stay private.
    if (!containerReady) containerReady = containerClient.createIfNotExists()
    await containerReady
  }

  const upload = async (blobName, payload, metadata) => {
    try {
      const containerClient = containerClientFn()
      await ensureContainer(containerClient)
      await uploadFn(containerClient, blobName, payload, metadata)
      persisted = true
      return true
    } catch (error) {
      failures++
      lastError = error.message
      containerReady = null
      if (failures === 1) logger('warn', [logPrefix, `Kunne ikke lagre kjoringen ${runId}: ${error.message}. Kjoringen fortsetter - fakturaene er merket med bulkRunId.`])
      return false
    }
  }

  const write = async (status, report) => {
    const { reportBlob, ...storedReport } = report
    const ok = await upload(fullBlobName(runId), {
      runId,
      status,
      startedAt,
      updatedAt: nowFn().toISOString(),
      report: storedReport
    }, metadataFrom(runId, status, startedAt, report))
    if (ok) lastFullAt = nowFn().getTime()
    return ok
  }

  const writeProgress = async (status, report) => {
    const ok = await upload(progressBlobName(runId), {
      runId,
      status,
      startedAt,
      updatedAt: nowFn().toISOString(),
      processed,
      total,
      tallies: talliesFrom(report),
      recent: [...recent]
    })
    if (ok) lastProgressAt = nowFn().getTime()
    return ok
  }

  return {
    blobName: fullBlobName(runId),
    progressBlobName: progressBlobName(runId),
    setTotal: (value) => { total = value },
    advance: () => { processed++ },
    note: (entry) => {
      recent.push(entry)
      if (recent.length > RECENT_LIMIT) recent.shift()
    },
    write,
    writeProgress,
    tick: async (status, report) => {
      const now = nowFn().getTime()
      if (now - lastProgressAt >= progressIntervalMs) await writeProgress(status, report)
      if (now - lastFullAt >= fullIntervalMs) await write(status, report)
    },
    state: () => ({ container: bulkInvoice.runContainer, blobName: fullBlobName(runId), persisted, failures, error: lastError })
  }
}

const runExists = async (runId, deps = {}) => {
  const { containerClientFn = getContainerClient } = deps
  const containerClient = containerClientFn()
  if (!await containerClient.exists()) return false
  return containerClient.getBlockBlobClient(fullBlobName(runId)).exists()
}

const readRun = async (runId, deps = {}) => {
  const { containerClientFn = getContainerClient } = deps
  const containerClient = containerClientFn()
  if (!await containerClient.exists()) return null
  return downloadJson(containerClient, fullBlobName(runId))
}

const readProgress = async (runId, deps = {}) => {
  const { containerClientFn = getContainerClient } = deps
  const containerClient = containerClientFn()
  if (!await containerClient.exists()) return null
  return downloadJson(containerClient, progressBlobName(runId))
}

/**
 * Summaries come from blob metadata, so a listing stays one request - listing returns properties
 * but never contents.
 */
const listRuns = async (limit = 25, deps = {}) => {
  const { containerClientFn = getContainerClient } = deps
  const containerClient = containerClientFn()
  if (!await containerClient.exists()) return []

  const runs = []
  for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
    if (!blob.name.endsWith('.json') || blob.name.endsWith('.progress.json')) continue
    const metadata = blob.metadata ?? {}
    runs.push({
      runId: metadata.runId ?? blob.name.replace(/\.json$/, ''),
      status: metadata.status ?? 'ukjent',
      startedAt: metadata.startedAt ?? null,
      updatedAt: blob.properties?.lastModified ?? null,
      dryRun: metadata.dryRun === 'true',
      mode: metadata.mode ?? null,
      totals: {
        contracts: Number(metadata.contracts ?? 0),
        rates: Number(metadata.rates ?? 0),
        sum: Number(metadata.sum ?? 0)
      }
    })
  }
  runs.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0))
  return runs.slice(0, limit)
}

const pruneExpiredRuns = async (retentionDays = bulkInvoice.runRetentionDays, deps = {}) => {
  const { containerClientFn = getContainerClient, nowFn = () => new Date() } = deps
  const containerClient = containerClientFn()
  if (!await containerClient.exists()) return { deleted: 0, failed: 0 }

  const cutoff = nowFn().getTime() - (retentionDays * 24 * 60 * 60 * 1000)
  let deleted = 0
  let failed = 0
  for await (const blob of containerClient.listBlobsFlat()) {
    if (new Date(blob.properties?.lastModified ?? 0).getTime() >= cutoff) continue
    try {
      await containerClient.getBlockBlobClient(blob.name).delete()
      deleted++
    } catch (error) {
      failed++
      logger('warn', [logPrefix, `Kunne ikke slette ${blob.name}: ${error.message}`])
    }
  }
  return { deleted, failed }
}

module.exports = {
  createBulkRunStore,
  runExists,
  readRun,
  readProgress,
  listRuns,
  pruneExpiredRuns,
  FULL_INTERVAL_MS,
  PROGRESS_INTERVAL_MS,
  RECENT_LIMIT
}
