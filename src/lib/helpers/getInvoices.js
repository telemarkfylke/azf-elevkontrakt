const { logger } = require("@vtfk/logger")
const { getDocuments } = require("../jobs/queryMongoDB")
const { getUser } = require("../jobs/queryMSGraph")
const { validateRoles } = require("../auth/validateRoles")

const schoolEnums = Object.freeze({
    'Skien videregående skole': 'Skien videregående skole',
    'Porsgrunn videregående skole': 'Porsgrunn videregående skole',
    'Bamble videregående skole': 'Bamble videregående skole',
    'Notodden videregående skole': 'Notodden videregående skole',
    'Kragerø videregående skole': 'Kragerø videregående skole',
    'Rjukan videregående skole': 'Rjukan videregående skole',
    'Skogmo videregående skole': 'Skogmo videregående skole',
    'Nome videregående skole avd Lunde': 'Nome videregående skole',
    'Nome videregående skole avd Søve': 'Nome videregående skole',
    'Bø videregående skule': 'Bø videregående skule',
    'Vest-Telemark vgs avd Dalen': 'Vest-Telemark videregående skule',
    'Vest-Telemark vidaregåande skule': 'Vest-Telemark vidaregåande skule',
    'Hjalmar Johansen videregående skole': 'Hjalmar Johansen videregående skole',
})

const getInvoices = async (request) => {
    const logPrefix = 'invoice'
    const authorizationHeader = request.headers.get('authorization')
    let isUserAdmin = false

    // Validate the authorization header
    if (validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
        isUserAdmin = true
    }

    let user = null
    if(request.query.get('upn') && !isUserAdmin) {
        const upn = await request.query.get('upn')
        if(!upn) {
            logger('error', [`${logPrefix} - ${request.method}`, 'No upn query parameter provided'])
            return { status: 400, body: 'Bad Request: No upn query parameter provided' }
        }

        const getUserResult = await getUser(upn)
        if(!getUserResult || !getUserResult.officeLocation) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Error fetching user data from Microsoft Graph', getUserResult.error])
            return { status: 500, body: 'Internal Server Error: Error fetching user data from Microsoft Graph' }
        }
        user = getUserResult
    }

    // Build a valid query object
    const query = {}
    if (user && user.officeLocation && !isUserAdmin) {
        const school = user.officeLocation
        if (schoolEnums[school]) {
            query['student.skole'] = schoolEnums[school]
        } else {
            logger('error', [`${logPrefix} - ${request.method}`, 'Invalid school query parameter provided'])
            return { status: 400, body: 'Bad Request: Invalid school query parameter provided' }
        }
    }

    const invoiceResult = await getDocuments(query, 'invoices')


    if(invoiceResult.status !== 200) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Error fetching invoices from the database', invoiceResult.error])
        return { status: 500, body: 'Internal Server Error: Error fetching invoices from the database' }
    }
    return { status: 200, jsonBody: invoiceResult.result }
}

module.exports = {
    getInvoices
}