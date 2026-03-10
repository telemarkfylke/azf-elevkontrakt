
/**
 * Function to process the invoices based on the provided body from the invoice function. It will handle both buyOut and extraInvoice types, generate serial numbers for buyOut rates, update the contract with the new status and serial numbers, and post the invoices to the xledgerExtraInvoice endpoint.
 * 
 * @param {Object} body 
 * @returns {Object} - An object containing the status and body of the invoice processing result.
 */

const { ObjectId } = require("mongodb")
const { getDocuments, updateDocument, postExtraInvoice } = require("./queryMongoDB")
const { logger } = require("@vtfk/logger")
const { generateSerialNumber } = require("../helpers/getSerialNumber")


const generateInvoices = async (body, request) => {
    const logPrefix = 'generateInvoices - processInvoices'
    let customerContract = await getDocuments({_id: new ObjectId(body.customerId)}, 'regular')

    if(customerContract.status !== 200 || customerContract.result.length === 0) {
        logger('error', [`${logPrefix} - ${request.method}`, 'No contract found for the provided customerId'])
        return { status: 404, body: 'Not Found: No contract found for the provided customerId' }
    } else {
        customerContract = customerContract.result[0]
    }

    let buyOutObject = null
    let extraInvoiceObject = null        

    // Handle buyOut invoice
    if(body.cart.buyOut.length > 0) {            
        // Get rates from fakturaInfo object.
        const ratesFromFakturaInfo = Object.keys(customerContract.fakturaInfo).filter(key => key.startsWith('rate')).map(key => customerContract.fakturaInfo[key])

        // Find the rates beeing invoiced in the contract based on the faktureringsår, this should be unique for each rate.
        const ratesToInvoice = []
        for (const buyOutItem of body.cart.buyOut) {
            let foundRate = null
            for (let i = 0; i < ratesFromFakturaInfo.length; i++) {
                const rate = ratesFromFakturaInfo[i]
                if (rate.faktureringsår === buyOutItem.faktureringsår && rate.status.toLowerCase() === 'ikke fakturert') {
                    const rateNumberFull = `rate${i + 1}`
                    const rateNumber = i + 1
                    const serialNumber = await generateSerialNumber(rateNumber)
                    const updateRate = {}
                    updateRate[`fakturaInfo.${rateNumberFull}.status`] = 'Fakturert - Utkjøp'
                    updateRate[`fakturaInfo.${rateNumberFull}.løpenummer`] = serialNumber
                    updateRate[`fakturaInfo.${rateNumberFull}.sum`] = buyOutItem.sum
                    await updateDocument(customerContract._id, updateRate, 'regular')
                    rate.løpenummer = serialNumber
                    foundRate = rate
                    break
                } else {
                    logger('info', [`${logPrefix} - ${request.method}`, `No match for faktureringsår ${buyOutItem.faktureringsår} and status "Ikke Fakturert" in rate: ${JSON.stringify(rate)}`])
                }
            }
            if (!foundRate) {
                logger('error', [`${logPrefix} - ${request.method}`, `No rate found for faktureringsår ${buyOutItem.faktureringsår} in the contract's fakturaInfo`])
            } else {
                ratesToInvoice.push(foundRate)
            }
        }

        if(ratesToInvoice.length === 0) {
            logger('error', [`${logPrefix} - ${request.method}`, 'No rates found for the provided faktureringsår that are not already invoiced'])
            return { status: 404, body: 'Not Found: No rates found for the provided faktureringsår that are not already invoiced' }
        }

        buyOutObject = {
            type: 'buyOut',
            customerContractId: customerContract._id,
            recipient: {
                ...customerContract.ansvarligInfo
            },
            student: {
                ...customerContract.elevInfo
            },
            skoleOrgNr: customerContract.skoleOrgNr,
            status: 'Ikke Fakturert',
            itemsFromCart: body.cart.buyOut,
            rates: ratesToInvoice,
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
            await postExtraInvoice(buyOutObject)
        } catch (error) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Error posting extra invoice', error])
            return { status: 500, body: 'Internal Server Error: Error posting buyOut invoice' }
        }
    }

    // Handle extraInvoice
    if(body.cart.extraInvoice.length > 0) {

        extraInvoiceObject = {
            type: 'extraInvoice',
            customerContractId: customerContract._id,
            recipient: {
                ...customerContract.ansvarligInfo
            },
            student: {
                ...customerContract.elevInfo
            },
            skoleOrgNr: customerContract.skoleOrgNr,
            status: 'Ikke Fakturert',
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
            await postExtraInvoice(extraInvoiceObject)
        } catch (error) {
            logger('error', [`${logPrefix} - ${request.method}`, 'Error posting extra invoice', error])
            return { status: 500, body: 'Internal Server Error: Error posting extra invoice' }
        }
    }
    // If the function has not returned by now, it means the invoice(s) have been processed successfully
    return { status: 200, body: 'Invoices processed successfully' }

}

module.exports = {
    generateInvoices
}