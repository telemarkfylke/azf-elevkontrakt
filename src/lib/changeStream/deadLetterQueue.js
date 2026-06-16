const { QueueServiceClient } = require('@azure/storage-queue')
const { BlobServiceClient } = require('@azure/storage-blob')
const { logger } = require('@vtfk/logger')
const { changeStream } = require('../../../config')
const { forwardChange } = require('./forwardChange')
const { retry } = require('./retry')

const DLQ_OVERFLOW_CONTAINER = 'change-stream-dlq-overflow'
const MAX_ATTEMPTS = 5
// Azure Storage Queue hard limit is 64 KB; stay safely below it
const MAX_MESSAGE_BYTES = 60 * 1024

const getQueueClient = () => {
  const queueServiceClient = QueueServiceClient.fromConnectionString(changeStream.storageConnectionString)
  return queueServiceClient.getQueueClient(changeStream.dlqName)
}

const getOverflowContainerClient = () => {
  const blobServiceClient = BlobServiceClient.fromConnectionString(changeStream.storageConnectionString)
  return blobServiceClient.getContainerClient(DLQ_OVERFLOW_CONTAINER)
}

const ensureInfrastructure = async () => {
  await getQueueClient().createIfNotExists()
  await getOverflowContainerClient().createIfNotExists()
}

const sendToDlq = async (changeEvent, error) => {
  await ensureInfrastructure()

  const payload = {
    attemptCount: 0,
    error: error?.message ?? String(error),
    event: changeEvent
  }

  let message = JSON.stringify(payload)

  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
    // Strip fullDocument and persist it in Blob Storage; store only a reference in the queue
    const fullDocument = changeEvent.fullDocument
    const blobName = `${changeEvent._id?.toString() ?? Date.now()}.json`
    const containerClient = getOverflowContainerClient()
    const blobClient = containerClient.getBlockBlobClient(blobName)
    const blobContent = JSON.stringify(fullDocument)
    await blobClient.upload(blobContent, Buffer.byteLength(blobContent), { overwrite: true })

    payload.event = { ...changeEvent, fullDocument: undefined, fullDocumentBlobRef: blobName }
    message = JSON.stringify(payload)
  }

  const queueClient = getQueueClient()
  await queueClient.sendMessage(Buffer.from(message).toString('base64'))
  logger('warn', ['deadLetterQueue', 'sendToDlq', `Event sent to DLQ. Error: ${error?.message ?? error}`])
}

const processDlq = async () => {
  await ensureInfrastructure()
  const queueClient = getQueueClient()
  const response = await queueClient.receiveMessages({ numberOfMessages: 32 })

  let forwarded = 0
  let failed = 0

  for (const msg of response.receivedMessageItems) {
    let payload
    try {
      payload = JSON.parse(Buffer.from(msg.messageText, 'base64').toString())
    } catch (err) {
      logger('error', ['deadLetterQueue', 'processDlq', `Failed to parse DLQ message: ${err.message}`])
      await queueClient.deleteMessage(msg.messageId, msg.popReceipt)
      continue
    }

    payload.attemptCount = (payload.attemptCount ?? 0) + 1

    let eventToForward = payload.event

    // Re-attach fullDocument from overflow Blob if present
    if (eventToForward.fullDocumentBlobRef) {
      try {
        const containerClient = getOverflowContainerClient()
        const blobClient = containerClient.getBlockBlobClient(eventToForward.fullDocumentBlobRef)
        const download = await blobClient.download()
        const chunks = []
        for await (const chunk of download.readableStreamBody) chunks.push(chunk)
        eventToForward = { ...eventToForward, fullDocument: JSON.parse(Buffer.concat(chunks).toString()), fullDocumentBlobRef: undefined }
      } catch (err) {
        logger('warn', ['deadLetterQueue', 'processDlq', `Could not fetch overflow blob: ${err.message}. Forwarding without fullDocument.`])
      }
    }

    try {
      await retry(() => forwardChange(eventToForward))
      await queueClient.deleteMessage(msg.messageId, msg.popReceipt)
      forwarded++
    } catch (err) {
      if (payload.attemptCount >= MAX_ATTEMPTS) {
        logger('error', ['deadLetterQueue', 'processDlq', `Event exhausted ${MAX_ATTEMPTS} attempts — dropping. Error: ${err.message}`])
        await queueClient.deleteMessage(msg.messageId, msg.popReceipt)
      } else {
        // Exponential back-off via visibilityTimeout (seconds): 5m, 10m, 20m, 40m
        const visibilityTimeout = Math.min(300 * Math.pow(2, payload.attemptCount - 1), 3600)
        const updatedMessage = Buffer.from(JSON.stringify(payload)).toString('base64')
        await queueClient.updateMessage(msg.messageId, msg.popReceipt, updatedMessage, visibilityTimeout)
        failed++
      }
    }
  }

  logger('info', ['deadLetterQueue', 'processDlq', `Done. Forwarded: ${forwarded}, failed/deferred: ${failed}`])
  return { forwarded, failed }
}

module.exports = { sendToDlq, processDlq }
