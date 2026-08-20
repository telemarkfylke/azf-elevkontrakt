/**
 * Maps a historiske-avtaler-pc-ikke-innlevert document to a Pureservice user patch payload.
 *
 * Returns { skip: reason } if the document should not be forwarded — the change stream
 * watcher and full-sync endpoint both honour this to skip silently, logging the reason.
 *
 * @param {object} doc - Full MongoDB document
 * @param {object} [changeEvent] - Raw change stream event. When omitted (full sync), always forwards.
 * @returns {{ pusId: number, patch: object } | { skip: string }}
 */
module.exports = (doc, changeEvent) => {
  if (!doc.pureserviceId) return { skip: 'pureserviceId not set' }

 // If this is a change stream event, only forward if fakturaInfo or pureserviceId was updated (insertions always forward).
  if (changeEvent) {
    const updatedKeys = Object.keys(changeEvent.updateDescription?.updatedFields ?? {})
    if (!updatedKeys.some(k => k.startsWith('fakturaInfo') || k === 'pureserviceId')) {
      return { skip: 'no fakturaInfo or pureserviceId field changed' }
    }
  }

  const cf2value = "{\"_id\": \"" + (doc._id ?? '') + "\", \"rate1\": \"" + (doc.fakturaInfo?.rate1?.status ?? '') + "\", \"rate2\": \"" + (doc.fakturaInfo?.rate2?.status ?? '') + "\", \"rate3\": \"" + (doc.fakturaInfo?.rate3?.status ?? '') + "\"}"

  return {
    pusId: doc.pureserviceId,
    patch: {
      cf_2: cf2value
    }
  }
}
