const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { getMongoClient } = require('../lib/auth/mongoClient')
const { readResumeToken, saveResumeToken, acquireLease, renewLease, releaseLease } = require('../lib/changeStream/resumeToken')
const { buildPipeline } = require('../lib/changeStream/buildPipeline')
const { forwardChange } = require('../lib/changeStream/forwardChange')
const { sendToDlq } = require('../lib/changeStream/deadLetterQueue')
const { retry } = require('../lib/changeStream/retry')
const { changeStream: csConfig, mongoDB } = require('../../config')

const runWatcher = async () => {
  const logPrefix = 'watchChangeStream'
  logger('info', [logPrefix, 'Started'])

  let leaseClient = null
  let renewalInterval = null
  let changeStreamCursor = null
  let forwarded = 0
  let dlq = 0

  try {
    try {
      leaseClient = await acquireLease()
    } catch (err) {
      logger('info', [logPrefix, 'Skipping run - another instance holds the lease'])
      return { skipped: true }
    }

    renewalInterval = setInterval(async () => {
      try {
        await renewLease(leaseClient)
      } catch (err) {
        logger('warn', [logPrefix, `Lease renewal failed: ${err.message}`])
      }
    }, 30_000)

    const resumeToken = await readResumeToken()
    const pipeline = buildPipeline(csConfig.watchCollections)

    const mongoClient = await getMongoClient()
    const db = mongoClient.db(mongoDB.dbName)

    const watchOptions = { fullDocument: 'updateLookup' }
    if (resumeToken) watchOptions.resumeAfter = resumeToken

    changeStreamCursor = db.watch(pipeline, watchOptions)

    const closeTimeout = setTimeout(() => {
      if (changeStreamCursor && !changeStreamCursor.closed) changeStreamCursor.close()
    }, csConfig.listeningWindowMs)

    try {
      for await (const event of changeStreamCursor) {
        try {
          await retry(() => forwardChange(event))
          await saveResumeToken(event._id, leaseClient?.leaseId)
          forwarded++
        } catch (err) {
          logger('error', [logPrefix, `Failed to forward event after retries: ${err.message}. Sending to DLQ.`])
          await sendToDlq(event, err)
          await saveResumeToken(event._id, leaseClient?.leaseId)
          dlq++
        }
      }
    } finally {
      clearTimeout(closeTimeout)
    }
  } catch (err) {
    if (err.code === 286) {
      logger('error', [logPrefix, 'Resume token expired (oplog window exceeded). Clearing token and restarting from tip of oplog on next run.'])
      try { await saveResumeToken(null) } catch (saveErr) {
        logger('warn', [logPrefix, `Could not clear resume token: ${saveErr.message}`])
      }
    } else if (err.message?.includes('ChangeStream is closed')) {
      // Normal — the listening window timeout closed the cursor
    } else {
      logger('error', [logPrefix, `Unhandled error: ${err.message}`])
      throw err
    }
  } finally {
    if (renewalInterval) clearInterval(renewalInterval)
    if (changeStreamCursor && !changeStreamCursor.closed) {
      try { await changeStreamCursor.close() } catch { /* ignore */ }
    }
    if (leaseClient) await releaseLease(leaseClient)
  }

  logger('info', [logPrefix, `Listening window closed - forwarded: ${forwarded}, sent to DLQ: ${dlq}`])
  return { forwarded, dlq }
}

app.timer('watchChangeStream', {
  schedule: '0 */30 * * * *',
  handler: async (myTimer, context) => {
    await runWatcher()
  }
})

app.http('watchChangeStreamDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/watchChangeStream',
  handler: async (request, context) => {
    try {
      const result = await runWatcher()
      return { status: 200, jsonBody: result }
    } catch (err) {
      return { status: 500, jsonBody: { error: err.message } }
    }
  }
})
