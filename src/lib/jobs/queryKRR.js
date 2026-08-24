const axios = require('axios')
const { krr } = require('../../../config')
const { logger } = require('@vtfk/logger')
const { sanitizeErrorForLogging } = require('../helpers/maskFnr')

const lookupKRR = async (ssn) => {
  const request = {
    method: 'post',
    url: krr.url,
    headers: {
      'x-functions-key': krr.key
    },
    data: [`${ssn}`]
  }

  try {
    const krrData = await axios.request(request)
    return krrData.data
  } catch (error) {
    logger('error', ['queryKRR', 'Klarte ikke å hente data fra KRR', sanitizeErrorForLogging(error)])
    return { status: 500, message: 'Internal server error' }
  }
}

module.exports = {
  lookupKRR
}
