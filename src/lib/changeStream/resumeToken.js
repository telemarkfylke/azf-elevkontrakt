const { BlobServiceClient } = require('@azure/storage-blob')
const { changeStream } = require('../../../config')

const getContainerClient = () => {
  const blobServiceClient = BlobServiceClient.fromConnectionString(changeStream.storageConnectionString)
  return blobServiceClient.getContainerClient(changeStream.tokenBlobContainer)
}

const getBlobClient = () => getContainerClient().getBlockBlobClient(changeStream.tokenBlobName)

const ensureContainer = async () => {
  await getContainerClient().createIfNotExists()
}

const readResumeToken = async () => {
  await ensureContainer()
  const blobClient = getBlobClient()
  const exists = await blobClient.exists()
  if (!exists) return null
  const download = await blobClient.download()
  const chunks = []
  for await (const chunk of download.readableStreamBody) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

const saveResumeToken = async (token, leaseId) => {
  const blobClient = getBlobClient()
  const content = JSON.stringify(token)
  const options = { overwrite: true }
  if (leaseId) options.conditions = { leaseId }
  await blobClient.upload(content, Buffer.byteLength(content), options)
}

const acquireLease = async () => {
  await ensureContainer()
  const blobClient = getBlobClient()
  // Ensure the blob exists so we can lease it — upload empty token if first run
  const exists = await blobClient.exists()
  if (!exists) {
    await blobClient.upload('null', 4, { overwrite: false })
  }
  const leaseClient = blobClient.getBlobLeaseClient()
  // 60-second lease — must be renewed every 30 s while the stream is running
  await leaseClient.acquireLease(60)
  return leaseClient
}

const renewLease = async (leaseClient) => {
  await leaseClient.renewLease()
}

const releaseLease = async (leaseClient) => {
  try {
    await leaseClient.releaseLease()
  } catch {
    // Lease may have expired already — not an error
  }
}

module.exports = { readResumeToken, saveResumeToken, acquireLease, renewLease, releaseLease }
