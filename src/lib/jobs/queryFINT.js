const axios = require('axios');
const { fint } = require('../../../config');
const { logger } = require('@vtfk/logger');
const getMsalToken = require('../auth/get-endtraid-token');

const queryFINT = async (request) => {
    const accessToken = await getMsalToken(fint.scope);

    const fintRequest = {
        method: request.method,
        url: request.url,
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    }
    
    try {
        const fintData = await axios.request(fintRequest)
        return fintData.data
    } catch (error) {
        if(error.status === 404) {
            logger('warn', ['queryFINT', 'Fant ikke data i FINT', error])
            return { status: 404, message: 'Personen er ikke en student' }
        }
        logger('error', ['queryFINT', 'Klarte ikke å hente data fra FINT', error])
        return { status: 500, message: 'Internal server error' }
    }
}

const employee = async (ssn) => {
    const request = {
        method: 'get',
        url: `${fint.url}/${fint.endPointEmployee}/${fint.queryTypeSSN}/${ssn}`
    }

    const fintData = await queryFINT(request);

    return fintData
}

const student = async (ssn, useElevnummer) => {
    // Check if useElevnummer is provided, if not default to false
    if (useElevnummer === undefined) {
        useElevnummer = false;
    }
    const request = {
        method: 'get',
        url: `${fint.url}/${fint.endPointStudent}/${fint.queryTypeSSN}/${ssn}?useElevnummer=${useElevnummer}`
    }

    const fintData = await queryFINT(request);

    return fintData
}

const schoolInfo = async (orgId) => {
    const request = {
        method: 'get',
        url: `${fint.url}/${fint.endPointSchoolInfo}/${fint.queryTypeOrgId}/${orgId}`
    }

    const fintData = await queryFINT(request);

    return fintData
}

module.exports = {
    employee,
    student,
    schoolInfo
}