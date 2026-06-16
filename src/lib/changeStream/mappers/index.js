/**
 * Mapper registry — one entry per watched collection.
 *
 * Each mapper is a function: (doc) => { pusId, patch } | null
 *   - pusId:  Pureservice user ID to PATCH
 *   - patch:  PusUserInput fields to update
 *   - null:   skip this document (e.g. pureserviceId not yet set)
 *
 * The collection name in CHANGE_STREAM_WATCH_COLLECTIONS must match a key here.
 * Add a new mapper file under mappers/ and register it below.
 */
module.exports = {
  kontrakter: require('./kontrakter'),
  'historiske-avtaler-pc-ikke-innlevert': require('./historiskePcIkkeInnlevert')
}
