/**
 * Builds a MongoDB aggregation pipeline for db.watch() from the watchCollections config.
 *
 * Each collection entry contributes:
 *   - One condition per watched field (update events where that field changed)
 *   - An insert condition if includeInserts is true
 *   - A delete condition if includeDeletes is true
 *
 * Dot-notation field names ("student.firstName") are passed through verbatim — MongoDB
 * represents nested updates the same way in updateDescription.updatedFields.
 *
 * @param {Array<{ collection: string, fields: string[], includeInserts?: boolean, includeDeletes?: boolean }>} watchCollections
 * @returns {Array} MongoDB aggregation pipeline
 */
const buildPipeline = (watchCollections) => {
  if (!watchCollections || watchCollections.length === 0) return []

  const conditions = []

  for (const { collection, fields = [], includeInserts = false, includeDeletes = false } of watchCollections) {
    if (fields.length === 0) {
      // No field filter — forward all updates for this collection
      conditions.push({ 'ns.coll': collection, operationType: 'update' })
    } else {
      for (const field of fields) {
        // Note: only works for top-level fields. Flat dot-notation keys stored by MongoDB
        // (e.g. updatedFields["fakturaInfo.rate1.status"]) cannot be matched with dot
        // navigation — use a top-level field (e.g. "fakturaInfo") or leave fields empty.
        conditions.push({
          'ns.coll': collection,
          operationType: 'update',
          [`updateDescription.updatedFields.${field}`]: { $exists: true }
        })
      }
    }

    if (includeInserts) {
      conditions.push({ 'ns.coll': collection, operationType: 'insert' })
    }

    if (includeDeletes) {
      conditions.push({ 'ns.coll': collection, operationType: 'delete' })
    }
  }

  if (conditions.length === 0) return []

  return [{ $match: { $or: conditions } }]
}

module.exports = { buildPipeline }
