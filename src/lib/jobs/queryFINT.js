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
            logger('error', ['queryFINT', 'Not found', error])
            return { status: 404, message: 'Not a student' }
        }
        return error
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

const student = async (ssn) => {
    const request = {
        method: 'get',
        url: `${fint.url}/${fint.endPointStudent}/${fint.queryTypeSSN}/${ssn}`
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