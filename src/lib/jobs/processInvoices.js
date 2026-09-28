
/**
 * Invoice processing: buyOut and extraInvoice.
 */

const { ObjectId } = require("mongodb")
const { getDocuments, updateDocument, postExtraInvoice } = require("./queryMongoDB")
const { assertContractUpdated } = require("./findContract")
const { logger } = require("@vtfk/logger")
const { generateSerialNumber } = require("../helpers/getSerialNumber")


/**
 * Matches each cart item to an unpaid rate by faktureringsår, mints a serial number, flips the rate,
 * then posts the invoice. Shared by the cart checkout (generateInvoices) and the Pureservice buyout
 * sync - callers build invoiceCreatedBy themselves.
 * @param {Object} customerContract - full contract document
 * @param {Array<{faktureringsår: *, sum: *}>} buyOutItems
 * @param {string} mainDocumentCollectionSource - 'regular' | 'pcIkkeInnlevert'. A HINT: contracts move
 *   collections, so later writers must resolve via findContractById.
 *   See docs/pc-ikke-innlevert-lifecycle.md.
 * @param {Object} invoiceCreatedBy - { name, givenName, surname, email, companyName, officeLocation, jobTitle }
 * @param {Object} [deps]
 * @param {String} [deps.rateStatusOnInvoice] - status written to the rate, default 'Fakturert - Utkjøp'.
 *   A one-off termin invoice on these rails is not a buyout and must read 'Fakturert'. Stored on the
 *   invoice too, or updateImportedBuyOutDocument relabels it on the way back from Xledger.
 * @param {String} [deps.invoiceLineLabel] - overrides the text on the invoice line, so a one-off termin
 *   invoice does not tell a guardian their PC was bought out. Omitted for a real buyout.
 * @param {String} [deps.bulkRunId] - correlates the invoices from one bulkInvoiceFromFile run, whose
 *   report can be lost with the HTTP response. Absent for the cart and Pureservice callers.
 * @returns {Promise<{status: number, body: string}>}
 */
const createBuyOutInvoice = async (customerContract, buyOutItems, mainDocumentCollectionSource, invoiceCreatedBy, deps = {}) => {
    const {
        updateDocument: _updateDocument = updateDocument,
        postExtraInvoice: _postExtraInvoice = postExtraInvoice,
        generateSerialNumber: _generateSerialNumber = generateSerialNumber,
        logger: _logger = logger,
        rateStatusOnInvoice = 'Fakturert - Utkjøp',
        invoiceLineLabel,
        bulkRunId,
    } = deps

    const logPrefix = 'createBuyOutInvoice - processInvoices'

    const ratesFromFakturaInfo = Object.keys(customerContract.fakturaInfo).filter(key => key.startsWith('rate')).map(key => customerContract.fakturaInfo[key])

    // faktureringsår is unique per rate, so it is what a cart item matches on.
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
                updateRate[`fakturaInfo.${rateNumberFull}.status`] = rateStatusOnInvoice
                updateRate[`fakturaInfo.${rateNumberFull}.løpenummer`] = serialNumber
                updateRate[`fakturaInfo.${rateNumberFull}.sum`] = buyOutItem.sum
                const updateResult = await _updateDocument(customerContract._id, updateRate, mainDocumentCollectionSource)
                // If the contract moved collections since the caller read it, the rate would silently keep
                // 'Ikke Fakturert' and the normal run would bill it again. Bail rather than post an invoice
                // the contract disagrees with - a partial update at least surfaces as a 500.
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
        // _id survives every collection move, so this is the reliable link.
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
        // Read back on import, so it does not assume every invoice here is a buyout.
        rateStatusOnInvoice,
        // Conditional, so a real buyout's document is unchanged from before these options existed.
        ...(invoiceLineLabel ? { invoiceLineLabel } : {}),
        ...(bulkRunId ? { bulkRunId } : {}),
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

        // A double "send" before the nightly import would otherwise leave two pending invoices.
        const existingPendingExtraInvoice = await _getDocuments({ customerContractId: customerContract._id, type: 'extraInvoice', status: 'Ikke Fakturert' }, 'invoices')
        if (existingPendingExtraInvoice.status === 200 && existingPendingExtraInvoice.result.length > 0) {
            _logger('error', [`${logPrefix} - ${request.method}`, `A pending extraInvoice already exists for customerContractId: ${customerContract._id}`])
            return { status: 409, body: 'Conflict: A pending extra invoice already exists for this contract' }
        }

        // Minted once and persisted: regenerating it per import run would turn a retry into a second
        // invoice for the same cart.
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
    return { status: 200, body: 'Invoices processed successfully' }

}

module.exports = {
    generateInvoices,
    createBuyOutInvoice
}