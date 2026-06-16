/**
 * Maps a historiske-avtaler-pc-ikke-innlevert document to a Pureservice user patch payload.
 *
 * Returns null if the document should not be forwarded — the change stream
 * watcher and full-sync endpoint both honour this to skip silently.
 *
 * @param {object} doc - Full MongoDB document
 * @param {object} [changeEvent] - Raw change stream event. When omitted (full sync), always forwards.
 * @returns {{ pusId: number, patch: object } | null}
 */
module.exports = (doc, changeEvent) => {
  if (!doc.pureserviceId) return null

 // If this is a change stream event, only forward if fakturaInfo was updated (insertions always forward).
  if (changeEvent) {
    const updatedKeys = Object.keys(changeEvent.updateDescription?.updatedFields ?? {})
    if (!updatedKeys.some(k => k.startsWith('fakturaInfo'))) return null
  }

  const cf2value = "{\"_id\": \"" + (doc._id ?? '') + "\", \"rate1\": \"" + (doc.fakturaInfo?.rate1?.status ?? '') + "\", \"rate2\": \"" + (doc.fakturaInfo?.rate2?.status ?? '') + "\", \"rate3\": \"" + (doc.fakturaInfo?.rate3?.status ?? '') + "\"}"

  return {
    pusId: doc.pureserviceId,
    patch: {
      cf_2: cf2value
    }
  }
}
