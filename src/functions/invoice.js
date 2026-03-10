const { app } = require('@azure/functions');
const { validateRoles } = require('../lib/auth/validateRoles');
const { getDocuments, updateDocument, postExtraInvoice } = require('../lib/jobs/queryMongoDB');
const { ObjectId } = require('mongodb');
const { logger } = require('@vtfk/logger');
const { generateSerialNumber } = require('../lib/helpers/getSerialNumber');
const { generateInvoices } = require('../lib/jobs/processInvoices');

app.http('invoiceSend', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invoice/send',
    handler: async (request, context) => {
        const logPrefix = 'invoice - send'
        const authorizationHeader = request.headers.get('authorization')

        /**
         * Generates invoices for buyOut items and extra invoice items in the cart, and posts to mongoDB to be picked up by the XledgerInvoiceImport function.
         */

        // Validate the authorization header
        if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
            return { status: 403, body: 'Forbidden' }
        }

        const body = await request.json()
        if(!body) {
            logger('error', [`${logPrefix} - ${request.method}`, 'No data provided in the request body'])
            return { status: 400, body: 'Bad Request: No data provided' }
        }

        if(!body.customerId) {
            logger('error', [`${logPrefix} - ${request.method}`, 'No customerId provided in the request body'])
            return { status: 400, body: 'Bad Request: No customerId provided' }
        }

        const invoiceResult = await generateInvoices(body, request)
        return { status: invoiceResult.status, body: invoiceResult.body }
    }
});

app.http('invoice', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'invoice',
    handler: async (request, context) => {
        const logPrefix = 'invoice - get'
        const authorizationHeader = request.headers.get('authorization')

        // Validate the authorization header
        if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
            return { status: 403, body: 'Forbidden' }
        }

        return { status: 200, body: 'Invoice endpoint is up and running, not implemented yet :P' }
    }
});
