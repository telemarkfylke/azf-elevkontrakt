'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { buildPipeline } = require('../buildPipeline')

// =====================================================================
// buildPipeline — turns the CHANGE_STREAM_WATCH_COLLECTIONS config into the
// $match handed to db.watch(). A wrong condition here either floods
// Pureservice with events or silently drops all of them, and neither shows
// up as an error at runtime.
// =====================================================================

describe('buildPipeline', () => {
  test('returns an empty pipeline for undefined', () => {
    assert.deepEqual(buildPipeline(undefined), [])
  })

  test('returns an empty pipeline for an empty array', () => {
    assert.deepEqual(buildPipeline([]), [])
  })

  test('returns an empty pipeline for null', () => {
    assert.deepEqual(buildPipeline(null), [])
  })

  test('wraps the conditions in a single $match with $or', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo'] }])

    assert.equal(pipeline.length, 1)
    assert.deepEqual(Object.keys(pipeline[0]), ['$match'])
    assert.deepEqual(Object.keys(pipeline[0].$match), ['$or'])
    assert.ok(Array.isArray(pipeline[0].$match.$or))
  })

  test('builds one update condition per watched field', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo', 'pureserviceId'] }])

    assert.deepEqual(pipeline[0].$match.$or, [
      {
        'ns.coll': 'kontrakter',
        operationType: 'update',
        'updateDescription.updatedFields.fakturaInfo': { $exists: true }
      },
      {
        'ns.coll': 'kontrakter',
        operationType: 'update',
        'updateDescription.updatedFields.pureserviceId': { $exists: true }
      }
    ])
  })

  test('an empty fields array forwards all updates for the collection instead', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: [] }])

    assert.deepEqual(pipeline[0].$match.$or, [
      { 'ns.coll': 'kontrakter', operationType: 'update' }
    ])
  })

  test('an omitted fields property is treated the same as an empty array', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter' }])

    assert.deepEqual(pipeline[0].$match.$or, [
      { 'ns.coll': 'kontrakter', operationType: 'update' }
    ])
  })

  test('includeInserts appends an insert condition', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo'], includeInserts: true }])

    assert.equal(pipeline[0].$match.$or.length, 2)
    assert.deepEqual(pipeline[0].$match.$or[1], { 'ns.coll': 'kontrakter', operationType: 'insert' })
  })

  test('includeDeletes appends a delete condition', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo'], includeDeletes: true }])

    assert.equal(pipeline[0].$match.$or.length, 2)
    assert.deepEqual(pipeline[0].$match.$or[1], { 'ns.coll': 'kontrakter', operationType: 'delete' })
  })

  test('includeInserts and includeDeletes both append, inserts first', () => {
    const pipeline = buildPipeline([{
      collection: 'kontrakter',
      fields: [],
      includeInserts: true,
      includeDeletes: true
    }])

    assert.deepEqual(pipeline[0].$match.$or, [
      { 'ns.coll': 'kontrakter', operationType: 'update' },
      { 'ns.coll': 'kontrakter', operationType: 'insert' },
      { 'ns.coll': 'kontrakter', operationType: 'delete' }
    ])
  })

  test('inserts and deletes default to off when not specified', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo'] }])

    assert.equal(pipeline[0].$match.$or.length, 1)
    assert.equal(pipeline[0].$match.$or[0].operationType, 'update')
  })

  test('accumulates multiple collections into one flat $or', () => {
    const pipeline = buildPipeline([
      { collection: 'kontrakter', fields: ['fakturaInfo'] },
      { collection: 'historiske-avtaler-pc-ikke-innlevert', fields: ['fakturaInfo'], includeInserts: true }
    ])

    const conditions = pipeline[0].$match.$or
    assert.equal(conditions.length, 3)
    assert.equal(conditions[0]['ns.coll'], 'kontrakter')
    assert.equal(conditions[1]['ns.coll'], 'historiske-avtaler-pc-ikke-innlevert')
    assert.equal(conditions[2]['ns.coll'], 'historiske-avtaler-pc-ikke-innlevert')
    assert.equal(conditions[2].operationType, 'insert')
  })

  test('passes dot-notation field names through verbatim', () => {
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: ['fakturaInfo.rate1.status'] }])

    assert.deepEqual(pipeline[0].$match.$or[0], {
      'ns.coll': 'kontrakter',
      operationType: 'update',
      'updateDescription.updatedFields.fakturaInfo.rate1.status': { $exists: true }
    })
  })

  test('a collection with no fields and no inserts or deletes still yields a catch-all update condition', () => {
    // The only way to reach the "no conditions" guard is an entry list that produces nothing,
    // which the current config shape cannot do — every entry contributes at least one condition.
    const pipeline = buildPipeline([{ collection: 'kontrakter', fields: [], includeInserts: false, includeDeletes: false }])

    assert.equal(pipeline.length, 1)
    assert.equal(pipeline[0].$match.$or.length, 1)
  })
})
