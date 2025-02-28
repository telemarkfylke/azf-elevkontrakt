const { MongoClient } = require('mongodb')
const { mongoDB } = require('../../../config')
const { logger } = require('@vtfk/logger')

let client = null

/**
 *
 * @returns { import('mongodb').MongoClient }
 */
const getMongoClient = async () => {
  if (!client) {
    logger('info', ['mongo-client', 'Client does not exist - creating'])
    client = new MongoClient(mongoDB.connectionString)
    logger('info', ['mongo-client', 'Client connected'])
  }
  return client
}

const closeMongoClient = () => {
  if (client) client.close()
  client = null
}

module.exports = { getMongoClient, closeMongoClient }
