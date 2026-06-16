const { logger } = require('@vtfk/logger')
const { patchUser } = require('../jobs/queryPureservice')
const mappers = require('./mappers')

/**
 * Forwards a single change stream event to Pureservice.
 * Auth is handled by queryPureservice (API key, rate-limit retry).
 *
 * Returns without error if the mapper returns null (document has no pureserviceId yet).
 * Throws if no mapper exists for the collection — that indicates a misconfiguration
 * (CHANGE_STREAM_WATCH_COLLECTIONS should only list collections with a registered mapper).
 *
 * @param {object} changeEvent - Raw MongoDB change stream event (fullDocument must be present)
 */
const forwardChange = async (changeEvent) => {
  const collection = changeEvent.ns?.coll
  const mapper = mappers[collection]

  if (!mapper) {
    logger('error', ['forwardChange', `No mapper found for collection "${collection}". Check CHANGE_STREAM_WATCH_COLLECTIONS and registered mappers.`])
    throw new Error(`No mapper registered for collection "${collection}". Add one to src/lib/changeStream/mappers/.`)
  }

  logger('info', ['forwardChange', `updatedFields keys: ${Object.keys(changeEvent.updateDescription?.updatedFields ?? {}).join(', ')}`])

  const result = mapper(changeEvent.fullDocument, changeEvent)
  if (!result) {
    logger('info', ['forwardChange', `Skipping event for collection "${collection}" — mapper returned null (pureserviceId not set?)`])
    return
  }

  await patchUser(result.pusId, result.patch)
}

module.exports = { forwardChange }
