
/**
 * Function to process the invoices based on the provided body from the invoice function. It will handle both buyOut and extraInvoice types, generate serial numbers for buyOut rates, update the contract with the new status and serial numbers, and post the invoices to the xledgerExtraInvoice endpoint.
 * 
 * @param {Object} body 
 * @returns {Object} - An object containing the status and body of the invoice processing result.
 */

const { ObjectId } = require("mongodb")
const { getDocuments, updateDocument, postExtraInvoice } = require("./queryMongoDB")
const { assertContractUpdated } = require("./findContract")
const { logger } = require("@vtfk/logger")
const { generateSerialNumber } = require("../helpers/getSerialNumber")


/**
 * Builds and posts a buyOut invoice for a contract: matches each cart item to an unpaid
 * ('Ikke Fakturert') rate by faktureringsår, generates a serial number and flips that rate's
 * status/sum/løpenummer, then posts the invoice document. Shared by the manual cart-checkout
 * flow (generateInvoices, below) and the automated Pureservice buyout sync
 * (syncPureserviceAssetLifecycle.js) - callers unpack their own input shape (HTTP cart body vs.
 * computed values) and build invoiceCreatedBy themselves; this function only knows about the
 * contract and rates.
 * @param {Object} customerContract - full contract document
 * @param {Array<{faktureringsår: *, sum: *}>} buyOutItems
 * @param {string} mainDocumentCollectionSource - 'regular' | 'pcIkkeInnlevert'. Stored on the invoice
 *   as a HINT ONLY: the contract moves collections over its life and this value goes stale. Anything
 *   later writing to the contract must resolve the collection via findContractById first - see
 *   docs/pc-ikke-innlevert-lifecycle.md. Safe to use here because the caller has just read the
 *   contract out of this very collection.
 * @param {Object} invoiceCreatedBy - { name, givenName, surname, email, companyName, officeLocation, jobTitle }
 * @param {Object} [deps]
 * @returns {Promise<{status: number, body: string}>}
 */
const createBuyOutInvoice = async (customerContract, buyOutItems, mainDocumentCollectionSource, invoiceCreatedBy, deps = {}) => {
    const {
        updateDocument: _updateDocument = updateDocument,
        postExtraInvoice: _postExtraInvoice = postExtraInvoice,
        generateSerialNumber: _generateSerialNumber = generateSerialNumber,
        logger: _logger = logger,
    } = deps

    const logPrefix = 'createBuyOutInvoice - processInvoices'

    // Get rates from fakturaInfo object.
    const ratesFromFakturaInfo = Object.keys(customerContract.fakturaInfo).filter(key => key.startsWith('rate')).map(key => customerContract.fakturaInfo[key])

    // Find the rates beeing invoiced in the contract based on the faktureringsår, this should be unique for each rate.
    const ratesToInvoice = []
    for (const buyOutItem of buyOutItems) {
        let foundRate = null
        for (let i = 0; i < ratesFromFakturaInfo.length; i++) {
            const rate = ratesFromFakturaInfo[i]
            if (rate.faktureringsår === buyOutItem.faktureringsår && rate.status.toLowerCase() === 'ikke fakturert') {
                const rateNumberFull = `rate${i + 1}`
                const rateNumber = i + 1
                const serialNumber = await _generateSerialNumber(rateNumber)
                const updateRate = {}
                updateRate[`fakturaInfo.${rateNumberFull}.status`] = 'Fakturert - Utkjøp'
                updateRate[`fakturaInfo.${rateNumberFull}.løpenummer`] = serialNumber
                updateRate[`fakturaInfo.${rateNumberFull}.sum`] = buyOutItem.sum
                const updateResult = await _updateDocument(customerContract._id, updateRate, mainDocumentCollectionSource)
                // Largely shielded, since the caller looked the contract up in this same collection
                // moments ago (a wrong value would have 404'd there) - but if the contract moved in
                // between, the rate would silently keep 'Ikke Fakturert' and the normal invoice run
                // would bill the rate we just bought out.
                //
                // Bail rather than carry on: with several buyOut items an earlier rate may already
                // be flipped, so this can leave the contract partially updated - but that is visible
                // to the caller as a 500 and recoverable by hand, whereas continuing would post an
                // invoice whose rates the contract does not agree with, which is the silent
                // divergence this whole check exists to stop.
                const { updated, reason } = assertContractUpdated(updateResult, `${logPrefix} - kontrakt ${customerContract._id} i '${mainDocumentCollectionSource}'`)
                if (!updated) {
                  _logger('error', [logPrefix, `Klarte ikke oppdatere rate${rateNumber} på kontrakt ${customerContract._id}: ${reason}. Avbryter utkjøpsfakturaen - kontrakten kan være delvis oppdatert og må sjekkes.`])
                  return { status: 500, body: `Internal Server Error: Could not update rate${rateNumber} on the contract: ${reason}` }
                }
                rate.løpenummer = serialNumber
                foundRate = rate
                break
            } else {
                _logger('info', [logPrefix, `No match for faktureringsår ${buyOutItem.faktureringsår} and status "Ikke Fakturert" in rate: ${JSON.stringify(rate)}`])
            }
        }
        if (!foundRate) {
            _logger('error', [logPrefix, `No rate found for faktureringsår ${buyOutItem.faktureringsår} in the contract's fakturaInfo`])
        } else {
            ratesToInvoice.push(foundRate)
        }
    }

    if (ratesToInvoice.length === 0) {
        _logger('error', [logPrefix, 'No rates found for the provided faktureringsår that are not already invoiced'])
        return { status: 404, body: 'Not Found: No rates found for the provided faktureringsår that are not already invoiced' }
    }

    const buyOutObject = {
        type: 'buyOut',
        // customerContractId survives every collection move (moveAndDeleteDocument preserves _id),
        // so it is the reliable link. mainDocumentCollectionSource is only a hint - kept fresh by
        // moveAndDeleteDocument, but resolve via findContractById before writing to the contract.
        customerContractId: customerContract._id,
        mainDocumentCollectionSource,
        recipient: {
            ...customerContract.ansvarligInfo
        },
        student: {
            ...customerContract.elevInfo
        },
        skoleOrgNr: customerContract.skoleOrgNr,
        status: 'Ikke Fakturert',
        itemsFromCart: buyOutItems,
        rates: ratesToInvoice,
        invoiceCreatedBy,
        createdTimeStamp: new Date()
    }

    try {
        await _postExtraInvoice(buyOutObject)
    } catch (error) {
        _logger('error', [logPrefix, 'Error posting extra invoice', error])
        return { status: 500, body: 'Internal Server Error: Error posting buyOut invoice' }
    }

    return { status: 200, body: 'Invoices processed successfully' }
}

const generateInvoices = async (body, request, deps = {}) => {
    const {
        getDocuments: _getDocuments = getDocuments,
        updateDocument: _updateDocument = updateDocument,
        postExtraInvoice: _postExtraInvoice = postExtraInvoice,
        generateSerialNumber: _generateSerialNumber = generateSerialNumber,
        logger: _logger = logger,
    } = deps

    const logPrefix = 'generateInvoices - processInvoices'

    let customerContract = await _getDocuments({_id: new ObjectId(body.customerId)}, body.mainDocumentCollectionSource)

    if(customerContract.status !== 200 || customerContract.result.length === 0) {
        _logger('error', [`${logPrefix} - ${request.method}`, 'No contract found for the provided customerId'])
        return { status: 404, body: 'Not Found: No contract found for the provided customerId' }
    } else {
        customerContract = customerContract.result[0]
    }

    let extraInvoiceObject = null

    // Handle buyOut invoice
    if(body.cart.buyOut.length > 0) {
        const invoiceCreatedBy = {
            name: body.userInfo.displayName,
            givenName: body.userInfo.givenName,
            surname: body.userInfo.surname,
            email: body.userInfo.userPrincipalName,
            companyName: body.userInfo.companyName,
            officeLocation: body.userInfo.officeLocation,
            jobTitle: body.userInfo.jobTitle
        }
        const buyOutResult = await createBuyOutInvoice(customerContract, body.cart.buyOut, body.mainDocumentCollectionSource, invoiceCreatedBy, {
            updateDocument: _updateDocument,
            postExtraInvoice: _postExtraInvoice,
            generateSerialNumber: _generateSerialNumber,
            logger: _logger
        })
        if (buyOutResult.status !== 200) {
            return buyOutResult
        }
    }

    // Handle extraInvoice
    if(body.cart.extraInvoice.length > 0) {

        // Prevent creating a duplicate pending extraInvoice for the same contract (e.g. a double "send" click before the nightly Xledger import runs)
        const existingPendingExtraInvoice = await _getDocuments({ customerContractId: customerContract._id, type: 'extraInvoice', status: 'Ikke Fakturert' }, 'invoices')
        if (existingPendingExtraInvoice.status === 200 && existingPendingExtraInvoice.result.length > 0) {
            _logger('error', [`${logPrefix} - ${request.method}`, `A pending extraInvoice already exists for customerContractId: ${customerContract._id}`])
            return { status: 409, body: 'Conflict: A pending extra invoice already exists for this contract' }
        }

        // Generate the serial number once, here, and persist it on the invoice document.
        // If this were generated again later (in handleExtraInvoice) on every Xledger import run, a retry after a failed
        // status write-back would mint a brand-new invoice for the same cart instead of resending the same one.
        const løpenummer = await _generateSerialNumber(4)

        extraInvoiceObject = {
            type: 'extraInvoice',
            customerContractId: customerContract._id,
            mainDocumentCollectionSource: body.mainDocumentCollectionSource,
            recipient: {
                ...customerContract.ansvarligInfo
            },
            student: {
                ...customerContract.elevInfo
            },
            skoleOrgNr: customerContract.skoleOrgNr,
            status: 'Ikke Fakturert',
            løpenummer,
            itemsFromCart: body.cart.extraInvoice,
            rates: [],
            invoiceCreatedBy: {
                name: body.userInfo.displayName,
                givenName: body.userInfo.givenName,
                surname: body.userInfo.surname,
                email: body.userInfo.userPrincipalName,
                companyName: body.userInfo.companyName,
                officeLocation: body.userInfo.officeLocation,
                jobTitle: body.userInfo.jobTitle
            },
            createdTimeStamp: new Date()
        }

        try {
            await _postExtraInvoice(extraInvoiceObject)
        } catch (error) {
            _logger('error', [`${logPrefix} - ${request.method}`, 'Error posting extra invoice', error])
            return { status: 500, body: 'Internal Server Error: Error posting extra invoice' }
        }
    }
    // If the function has not returned by now, it means the invoice(s) have been processed successfully
    return { status: 200, body: 'Invoices processed successfully' }

}

module.exports = {
    generateInvoices,
    createBuyOutInvoice
}