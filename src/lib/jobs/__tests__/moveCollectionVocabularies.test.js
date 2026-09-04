'use strict'

/**
 * Guards the allowlists handleDbRequest's DELETE validates against. They live in queryMongoDB.js
 * next to the if/else chains that actually consume them, so there is one definition to keep in step
 * - if a branch is added to moveAndDeleteDocument without updating the list, these fail.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { VALID_MOVE_TARGET_COLLECTIONS, VALID_MOVE_SOURCE_COLLECTIONS } = require('../queryMongoDB.js')

const queryMongoDbSource = fs.readFileSync(path.join(__dirname, '..', 'queryMongoDB.js'), 'utf8')

describe('move collection vocabularies', () => {
  test('the target allowlist matches moveAndDeleteDocument targets', () => {
    assert.deepEqual(
      [...VALID_MOVE_TARGET_COLLECTIONS].sort(),
      ['contracts', 'deleted', 'duplicates', 'historic', 'pcIkkeInnlevert', 'regular']
    )
  })

  test('the source allowlist matches determineSourceCollectionName sources', () => {
    assert.deepEqual(
      [...VALID_MOVE_SOURCE_COLLECTIONS].sort(),
      ['error', 'historic', 'mock', 'pcIkkeInnlevert', 'preImport', 'regular']
    )
  })

  test("'error' and 'preImport' are sources but not targets", () => {
    // There is no way back into either collection through moveAndDeleteDocument - an unrecognised
    // target used to leave collection = '' and throw on createCollection('')
    for (const onlyASource of ['error', 'preImport']) {
      assert.ok(VALID_MOVE_SOURCE_COLLECTIONS.includes(onlyASource))
      assert.ok(!VALID_MOVE_TARGET_COLLECTIONS.includes(onlyASource))
    }
  })

  test("'duplicates' and 'deleted' are targets but not sources", () => {
    for (const onlyATarget of ['duplicates', 'deleted']) {
      assert.ok(VALID_MOVE_TARGET_COLLECTIONS.includes(onlyATarget))
      assert.ok(!VALID_MOVE_SOURCE_COLLECTIONS.includes(onlyATarget))
    }
  })

  test('every allowlisted source has a branch in determineSourceCollectionName', () => {
    for (const source of VALID_MOVE_SOURCE_COLLECTIONS) {
      assert.ok(
        queryMongoDbSource.includes(`sourceCollection === '${source}'`),
        `'${source}' is allowlisted but has no branch in determineSourceCollectionName`
      )
    }
  })

  test('every allowlisted target has a branch in moveDocumentToTargetCollection', () => {
    for (const target of VALID_MOVE_TARGET_COLLECTIONS) {
      assert.ok(
        queryMongoDbSource.includes(`targetCollection === '${target}'`),
        `'${target}' is allowlisted but has no branch in moveDocumentToTargetCollection`
      )
    }
  })
})
