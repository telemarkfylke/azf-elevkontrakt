const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { ObjectId } = require('mongodb')
const { getMongoClient } = require('../lib/auth/mongoClient')
const { patchUser } = require('../lib/jobs/queryPureservice')
const { retry } = require('../lib/changeStream/retry')
const mappers = require('../lib/changeStream/mappers')
const { changeStream: csConfig, mongoDB } = require('../../config')

/**
 * POST /changeStream/syncToPureservice
 *
 * Body (all optional):
 *   { "ids": ["uuid1", "uuid2"] }
 *
 * If ids is provided: sync only documents where uuid matches one of the given values.
 * If ids is omitted or empty: sync ALL documents in every mapped collection.
 *
 * Response: { [collectionName]: { total, synced, skipped, failed } }
 */
app.http('syncToPureservice', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'changeStream/syncToPureservice',
  handler: async (request, context) => {
    const logPrefix = 'syncToPureservice'
    logger('info', [logPrefix, 'Started'])

    let ids = []
    try {
      const body = await request.json().catch(() => ({}))
      if (Array.isArray(body?.ids) && body.ids.length > 0) {
        ids = body.ids
      }
    } catch {
      // No body or invalid JSON — treat as full sync
    }

    const isPartialSync = ids.length > 0
    logger('info', [logPrefix, isPartialSync ? `Partial sync for ${ids.length} id(s)` : 'Full sync'])

    const report = {}
    const mongoClient = await getMongoClient()
    const db = mongoClient.db(mongoDB.dbName)

    for (const [collectionName, mapper] of Object.entries(mappers)) {
      const counts = { total: 0, synced: 0, skipped: 0, failed: 0 }
      logger('info', [logPrefix, `Processing collection: ${collectionName}`])

      const filter = isPartialSync ? { _id: { $in: ids.map(id => new ObjectId(id)) } } : {}
      const documents = await db.collection(collectionName).find(filter).toArray()
      counts.total = documents.length

      for (const doc of documents) {
        const result = mapper(doc)
        if (!result) {
          counts.skipped++
          continue
        }

        try {
          await retry(() => patchUser(result.pusId, result.patch))
          counts.synced++
        } catch (err) {
          logger('error', [logPrefix, collectionName, `Failed to patch pureserviceId ${result.pusId}: ${err.message}`])
          counts.failed++
        }
      }

      logger('info', [logPrefix, collectionName, `Done — total: ${counts.total}, synced: ${counts.synced}, skipped: ${counts.skipped}, failed: ${counts.failed}`])
      report[collectionName] = counts
    }

    const hasFailures = Object.values(report).some(c => c.failed > 0)
    logger('info', [logPrefix, 'Completed', JSON.stringify(report)])

    return {
      status: hasFailures ? 207 : 200,
      jsonBody: report
    }
  }
})
