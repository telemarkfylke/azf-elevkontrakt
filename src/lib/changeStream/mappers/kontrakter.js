/**
 * Maps a contract document to a Pureservice user patch payload.
 *
 * Returns null if the document should not be forwarded — the change stream
 * watcher and full-sync endpoint both honour this to skip silently.
 *
 * PusUserInput field reference: azf-entraid-sync/src/adapters/pus/pusTypes.ts
 * Available fields:cf_2, check docs for details :P
 *
 * @param {object} doc - Full MongoDB contract document
 * @param {object} [changeEvent] - Raw change stream event. When provided (change stream path),
 *   only forwards if a fakturaInfo field was touched. When omitted (full sync), always forwards.
 * @returns {{ pusId: number, patch: object } | null}
 */
module.exports = (doc, changeEvent) => {
  if (!doc.pureserviceId) return null

  // If this is a change stream event, only forward if fakturaInfo or pureserviceId was updated (insertions always forward).
  if (changeEvent) {
    const updatedKeys = Object.keys(changeEvent.updateDescription?.updatedFields ?? {})
    if (!updatedKeys.some(k => k.startsWith('fakturaInfo') || k === 'pureserviceId')) return null
  }

  const cf2value = "{\"_id\": \"" + (doc._id ?? '') + "\", \"rate1\": \"" + (doc.fakturaInfo?.rate1?.status ?? '') + "\", \"rate2\": \"" + (doc.fakturaInfo?.rate2?.status ?? '') + "\", \"rate3\": \"" + (doc.fakturaInfo?.rate3?.status ?? '') + "\"}"

  return {
    pusId: doc.pureserviceId,
    patch: {
      // Example — update these to match the actual contract document schema:
      // department: doc.skole ?? null,
      // cf_1: doc.someCustomField ?? null
      cf_2: cf2value
    }
  }
}
