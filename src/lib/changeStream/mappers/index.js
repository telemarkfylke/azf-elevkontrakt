/**
 * Mapper registry — one entry per watched collection.
 *
 * Each mapper is a function: (doc, changeEvent) => { pusId, patch } | { skip: string }
 *   - pusId:  Pureservice user ID to PATCH
 *   - patch:  PusUserInput fields to update
 *   - skip:   reason to skip this document (e.g. pureserviceId not yet set, or
 *             no relevant field changed) — logged by the caller, not an error
 *
 * The collection name in CHANGE_STREAM_WATCH_COLLECTIONS must match a key here.
 * Add a new mapper file under mappers/ and register it below.
 */
module.exports = {
  kontrakter: require('./kontrakter'),
  'historiske-avtaler-pc-ikke-innlevert': require('./historiskePcIkkeInnlevert')
}
