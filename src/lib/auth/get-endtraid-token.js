const { ConfidentialClientApplication } = require('@azure/msal-node')
const NodeCache = require('node-cache')
const { appReg } = require('../../../config')
const { logger } = require('@vtfk/logger')

const cache = new NodeCache({ stdTTL: 3000 })

module.exports = async (scope, options = { forceNew: false }) => {
  const cacheKey = scope
  const logPrefix = 'getGraphToken'

  if (!options.forceNew && cache.get(cacheKey)) {
    logger('info', [logPrefix, 'found valid token in cache, will use that instead of fetching new'])
    return (cache.get(cacheKey))
  }

  logger('info', [logPrefix, 'no token in cache, fetching new from Microsoft'])
  const config = {
    auth: {
      clientId: appReg.clientId,
      authority: `https://login.microsoftonline.com/${appReg.tenantId}/`,
      clientSecret: appReg.clientSecret
    }
  }

  // Create msal application object
  const cca = new ConfidentialClientApplication(config)
  const clientCredentials = {
    scopes: [scope]
  }

  const token = await cca.acquireTokenByClientCredential(clientCredentials)
  const expires = Math.floor((token.expiresOn.getTime() - new Date()) / 1000)
  logger('info', [logPrefix, `Got token from Microsoft, expires in ${expires} seconds.`])
  cache.set(cacheKey, token.accessToken, expires)
  logger('info', [logPrefix, 'Token stored in cache'])

  return token.accessToken
}
