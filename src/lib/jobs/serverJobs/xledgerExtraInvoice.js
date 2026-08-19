// Send invoice to xledger

/**
 * Get documents from Invoice collection in MongoDB with status "Ikke Fakturert".
 * Create an object with all the necessary information for each invoice, and post to xledger.
 * Update the status of the invoice in MongoDB to "Fakturert" if the post was successful.
 * Update the user's contract in MongoDB ('regular' collection) with updated status "Fakturert" for the corresponding rate, but only if the invoice is a buyOut invoice. Extra invoices should not update the status of any rates in the contract.) 
 */

const { logger } = require("@vtfk/logger")
const { schoolInfoList } = require("../../datasources/tfk-schools")
const { hasInvoiceFlowException } = require("../../helpers/checkInvoiceFlowException")
const { returnCorrectPriceForStudent } = require("../../helpers/getCorrectRatePrice")
const { getDocuments, updateDocument } = require("../queryMongoDB")
const { getThisYearsPriceList } = require("../../helpers/getSettings")
const { generateInvoiceImportFile, sendImportFailureAlert } = require("./xledgerInvoiceImport")
const { generateSerialNumber } = require("../../helpers/getSerialNumber")
const { standardFields } = require("../../datasources/productStandardFields")

/**
 * 
 * @param {Array} invoices  
 */


const handleBuyOutInvoice = async (invoices, deps = {}) => {
    const {
        getThisYearsPriceList: _getThisYearsPriceList = getThisYearsPriceList,
        hasInvoiceFlowException: _hasInvoiceFlowException = hasInvoiceFlowException,
        schoolInfoList: _schoolInfoList = schoolInfoList,
        returnCorrectPriceForStudent: _returnCorrectPriceForStudent = returnCorrectPriceForStudent,
        generateInvoiceImportFile: _generateInvoiceImportFile = generateInvoiceImportFile,
        logger: _logger = logger,
    } = deps

    const csvDataArray = []
    const { prices, exceptionsFromRegularPrices, exceptionsFromInvoiceFlow } = await _getThisYearsPriceList()

    for (const invoice of invoices) {
        const hasException = _hasInvoiceFlowException(invoice.student.fnr, exceptionsFromInvoiceFlow)
        if (hasException) {
          // Using Error for easy notification to teams, so we know why we are skipping this document, and as a reminder to remove the exception later/manually handle the invoice
          _logger('error', ['createCsvDataArray', `Document with _id: ${invoice._id} has an exception in the invoice flow. Skipping invoice import.`])
          continue // Skip this document
        }
        const schoolInfo = _schoolInfoList.find(school => school.orgNr === parseInt(invoice?.skoleOrgNr))
        for (const [i, rate] of invoice.rates.entries()) {
            const csvData = {
                'Owner ID/Entity Code': '39006',
                ImpSystem: 'Skoleutvikling - JOTNE',
                'Order No': rate.løpenummer, // Serial number for the invoice
                'Line No': (i+1).toString(), // Line number for the invoice line, starting from 1
                // 'Date': new Date().toLocaleDateString('no-NO'), // Xledger will set the date automatically to the date of import
                'Ready To Invoice': '1', // Sett to manual review in Xledger before sending the invoice (1 means manual review, 2 means ready to be invoiced without review)
                Product: '4651000', // Product code for "ElevPC",
                'Tekst (imp)': `Faktura for ${invoice.student.navn} - Utkjøp av elev-PC - Faktura ${i+1}/${invoice.rates.length}`, // Description text for the invoice line
                Quantity: '1',
                'Unit Price': _returnCorrectPriceForStudent(invoice.student.fnr, invoice.student.klasse, prices, exceptionsFromRegularPrices), // Price based on settings and exceptions
                'Company No': invoice.recipient.fnr, // Person that will be invoiced
                'Service Type': '465',
                'Your Ref': invoice.student.navn, // Name of the student
                'SO Group': '465',
                'Header Info': schoolInfo?.xledgerInvoiceHeaderInfo || 'Spørsmål vedrørende faktura, ta kontakt med skolen din', // Unique header text for each school
                Dummy4: invoice._id, // Will not be imported to Xledger, used to update the document in the database after import
                'End Of Line': 'X'
            }
            // Build the CSV row based on the document and the rate to be invoiced
            csvDataArray.push(csvData)
        }
    }
   return await _generateInvoiceImportFile('buyOut', csvDataArray)
}
/**
 * 
 * @param {Array} invoices 
 */
const handleExtraInvoice = async (invoices, deps = {}) => {
    const {
        schoolInfoList: _schoolInfoList = schoolInfoList,
        generateSerialNumber: _generateSerialNumber = generateSerialNumber,
        standardFields: _standardFields = standardFields,
        generateInvoiceImportFile: _generateInvoiceImportFile = generateInvoiceImportFile,
        updateDocument: _updateDocument = updateDocument,
        logger: _logger = logger,
    } = deps

    const csvDataArray = []

    for (const invoice of invoices) {
        const schoolInfo = _schoolInfoList.find(school => school.orgNr === parseInt(invoice?.skoleOrgNr))
        // Reuse the serial number persisted at creation time (processInvoices.js) instead of generating a new one on every run.
        // Regenerating it here on every run meant a retry after a failed status write-back would mint a brand-new invoice for the same cart, every day.
        let serialNumber = invoice.løpenummer
        if (!serialNumber) {
            // Fallback for invoices created before løpenummer was persisted at creation time.
            serialNumber = await _generateSerialNumber(4)
            await _updateDocument(invoice._id, { løpenummer: serialNumber }, 'invoices')
            _logger('info', ['handleExtraInvoice', `No løpenummer found on invoice with _id: ${invoice._id}, generated and persisted a new one: ${serialNumber}`])
        }
        for (const [i, product] of invoice.itemsFromCart.entries()) {
            const extraFields = {}
            for (const key in product) {
                if (!_standardFields.includes(key)) {
                    extraFields[key] = product[key]
                }
            }

            // Build the text string for the "Tekst (imp)" field.
            const extraFieldsText = Object.entries(extraFields).map(([key, value]) => `${key}: ${value}`).join(' - ')


            const csvData = {
                'Owner ID/Entity Code': '39006',
                ImpSystem: 'Skoleutvikling - JOTNE',
                'Order No': serialNumber, // Serial number for the invoice
                'Line No': (i+1).toString(), // Line number for the invoice line, starting from 1
                // 'Date': new Date().toLocaleDateString('no-NO'), // Xledger will set the date automatically to the date of import
                'Ready To Invoice': '1', // Sett to manual review in Xledger before sending the invoice (1 means manual review, 2 means ready to be invoiced without review)
                Product: schoolInfo.xledgerSchoolProductNumber, // Product code for the school,
                'Tekst (imp)': `Faktura for ${invoice.student.navn} - ${product.name} - ${extraFieldsText}`, // Description text for the invoice line
                Quantity: '1',
                'Unit Price': product.price.toString(), // Price based on the product price in the cart
                'Company No': invoice.recipient.fnr, // Person that will be invoiced
                'Service Type': schoolInfo.xledgerInvoiceCustomString,
                'Your Ref': invoice.student.navn, // Name of the student
                'SO Group': schoolInfo.xledgerInvoiceCustomString,
                'Header Info': schoolInfo?.xledgerInvoiceHeaderInfo || 'Spørsmål vedrørende faktura, ta kontakt med skolen din', // Unique header text for each school
                Dummy4: invoice._id, // Will not be imported to Xledger, used to update the document in the database after import
                'End Of Line': 'X'
            }
            // Build the CSV row based on the document and the rate to be invoiced
            csvDataArray.push(csvData)
        }
    }
   return await _generateInvoiceImportFile('extraInvoice', csvDataArray)
}

/**
 * Main function to process invoices
 * @returns {Promise<void>}
 */
const processInvoices = async (deps = {}) => {
    const {
        getDocuments: _getDocuments = getDocuments,
        handleBuyOutInvoice: _handleBuyOutInvoice = handleBuyOutInvoice,
        handleExtraInvoice: _handleExtraInvoice = handleExtraInvoice,
        sendImportFailureAlert: _sendImportFailureAlert = sendImportFailureAlert,
        logger: _logger = logger,
    } = deps

    const logPrefix = 'processInvoices'
    const query = { 'status': 'Ikke Fakturert' }
    const invoicesResult = await _getDocuments(query, 'invoices')

    if(invoicesResult.status === 404 && invoicesResult.error === 'Fant ingen dokumenter') {
        _logger('info', [logPrefix, `No invoices found with status "Ikke Fakturert" in MongoDB`])
        return { status: 200, body: 'No invoices to process' }
    }

    if (invoicesResult.status !== 200) {
        _logger('error', [logPrefix, 'Error fetching invoices from MongoDB'])
        throw new Error('Error fetching invoices from MongoDB')
    }

    const invoices = invoicesResult.result

    const buyOutInvoices = invoices.filter(invoice => invoice.type === 'buyOut')
    const extraInvoices = invoices.filter(invoice => invoice.type === 'extraInvoice')

    if(buyOutInvoices.length === 0 && extraInvoices.length === 0) {
        _logger('info', [logPrefix, 'No invoices to process'])
        return { status: 200, body: 'No invoices to process' }
    }

    let buyOutResults
    let extraInvoiceResults
    if(buyOutInvoices.length > 0) {
        _logger('info', [logPrefix, `Processing ${buyOutInvoices.length} buyOut invoices`])
        try {
            buyOutResults = await _handleBuyOutInvoice(buyOutInvoices)
        } catch (error) {
            // Without this, an Xledger import failure aborts status write-back for the whole batch with nobody aware -
            // the same invoices get resent on the next scheduled run. Catch it here so extraInvoice can still be attempted below.
            _logger('error', [logPrefix, 'Error processing buyOut invoices', error])
            await _sendImportFailureAlert('buyOut', error)
        }
    }

    if(extraInvoices.length > 0) {
        _logger('info', [logPrefix, `Processing ${extraInvoices.length} extra invoices`])
        try {
            extraInvoiceResults = await _handleExtraInvoice(extraInvoices)
        } catch (error) {
            _logger('error', [logPrefix, 'Error processing extra invoices', error])
            await _sendImportFailureAlert('extraInvoice', error)
        }
    }

    return {
        buyOutResults,
        extraInvoiceResults
    }
}

module.exports = {
    processInvoices,
    handleBuyOutInvoice,
    handleExtraInvoice,
}




