const axios = require('axios');
const { freg } = require('../../../config');
const { logger } = require('@vtfk/logger');
const getMsalToken = require('../auth/get-endtraid-token');

const queryFREG = async (request) => {
    const accessToken = await getMsalToken(freg.scope);

    const fregRequest = {
        method: request.method,
        url: request.url,
        headers: {
            Authorization: `Bearer ${accessToken}`
        }, 
        data: request.data
    }
    
    try {
        const fregData = await axios.request(fregRequest)
        return fregData.data
    } catch (error) {
        return error
    }
}

const person = async (ssn) => {
    const request = {
        method: 'post',
        url: `${freg.url}/${freg.endPoint}`,
        data: {
            ssn: ssn,
            includeFortrolig: true,
            includeForeldreansvar: true,
        }
    }

    const fregData = await queryFREG(request)

    return fregData
}

module.exports = {
    person
}