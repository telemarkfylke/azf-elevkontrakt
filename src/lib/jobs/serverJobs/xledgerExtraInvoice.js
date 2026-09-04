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
const { findContractById } = require("../findContract")
const { isRecipientImportedToXledger } = require("../../helpers/checkXledgerRecipientImport")
const { maskFnr } = require("../../helpers/maskFnr")

/**
 * Decides whether an invoice may be sent to Xledger yet, by checking isImportedToXledger on its
 * source contract. Shared by both handlers below so the rule cannot drift between buyOut and
 * extraInvoice.
 *
 * The recipient ('Company No' in the CSV) has to exist as a customer in Xledger before an invoice
 * can reference it; the normal invoice run already selects on this flag
 * (xledgerInvoiceImport.js getXledgerInvoiceImports), these two runs did not - so an invoice for a
 * not-yet-imported responsible person landed in Xledger with an unknown subledger account and
 * someone had to create the recipient by hand.
 *
 * Fails closed: a contract that cannot be found, or a lookup that throws, counts as not imported.
 * Skipping costs nothing - the invoice keeps status 'Ikke Fakturert' and the next run picks it up
 * once the flag flips - whereas a wrongly sent invoice means manual work in Xledger.
 *
 * The collection is resolved with findContractById rather than read from the invoice's
 * mainDocumentCollectionSource: that field records where the contract lived when the invoice was
 * created and goes stale (see docs/pc-ikke-innlevert-lifecycle.md).
 *
 * @param {Object} invoice | An invoice document from the 'invoices' collection
 * @param {Object} [deps]
 * @returns {Promise<{imported: boolean, skip: Object|null}>} | skip is the report record when imported is false
 */
const resolveRecipientImportStatus = async (invoice, deps = {}) => {
    const {
        findContractById: _findContractById = findContractById,
        isRecipientImportedToXledger: _isRecipientImportedToXledger = isRecipientImportedToXledger,
    } = deps

    const buildSkip = (reason, documentType = null) => ({
        invoiceId: String(invoice._id),
        customerContractId: invoice.customerContractId ? String(invoice.customerContractId) : 'mangler',
        studentName: invoice.student?.navn || 'Ukjent',
        recipientName: invoice.recipient?.navn || 'Ukjent',
        recipientFnr: maskFnr(invoice.recipient?.fnr),
        // How long the invoice has been waiting, so the Teams card can escalate holds that are never
        // going to lift on their own. A pending invoice is re-examined by every run, so time since
        // creation is time held. Absent on invoices predating the field - reported as unknown there.
        createdTimeStamp: invoice.createdTimeStamp || null,
        documentType,
        reason
    })

    try {
        const { contract, documentType } = await _findContractById(invoice.customerContractId)
        if (!contract) {
            return { imported: false, skip: buildSkip('Fant ingen kontrakt i kontrakter, pc-ikke-innlevert eller historiske-avtaler - kan ikke bekrefte at mottakeren er importert til Xledger') }
        }
        if (!_isRecipientImportedToXledger(contract)) {
            return { imported: false, skip: buildSkip(`Mottakeren er ikke importert til Xledger (isImportedToXledger = ${JSON.stringify(contract.isImportedToXledger)})`, documentType) }
        }
        return { imported: true, skip: null }
    } catch (error) {
        return { imported: false, skip: buildSkip(`Oppslag av kontrakten feilet: ${error.message}`) }
    }
}

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
        findContractById: _findContractById = findContractById,
        isRecipientImportedToXledger: _isRecipientImportedToXledger = isRecipientImportedToXledger,
        logger: _logger = logger,
    } = deps

    const csvDataArray = []
    // Invoices held back because their recipient is not in Xledger yet - reported on the Teams card.
    const skippedNotImportedToXledger = []
    const { prices, exceptionsFromRegularPrices, exceptionsFromInvoiceFlow } = await _getThisYearsPriceList()

    for (const invoice of invoices) {
        const hasException = _hasInvoiceFlowException(invoice.student.fnr, exceptionsFromInvoiceFlow)
        if (hasException) {
          // Using Error for easy notification to teams, so we know why we are skipping this document, and as a reminder to remove the exception later/manually handle the invoice
          _logger('error', ['createCsvDataArray', `Document with _id: ${invoice._id} has an exception in the invoice flow. Skipping invoice import.`])
          continue // Skip this document
        }

        // Note for buyOut specifically: the contract's rate was already flipped to 'Fakturert - Utkjøp'
        // with its løpenummer when the invoice was created (createBuyOutInvoice in processInvoices.js).
        // Holding the invoice back therefore leaves the contract in exactly the state every pending
        // buyOut is in between checkout and this run - and that reservation is what stops the normal
        // invoice run from billing the same rate, so it must stay. The Teams card is the signal that a
        // rate is sitting reserved on a recipient that cannot be invoiced yet.
        const { imported, skip } = await resolveRecipientImportStatus(invoice, {
            findContractById: _findContractById,
            isRecipientImportedToXledger: _isRecipientImportedToXledger,
        })
        if (!imported) {
            skippedNotImportedToXledger.push(skip)
            _logger('warn', ['handleBuyOutInvoice', `Invoice with _id: ${invoice._id} was left alone: ${skip.reason}. Status stays 'Ikke Fakturert' and it will be retried on the next run.`])
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
   return await _generateInvoiceImportFile('buyOut', csvDataArray, { skippedNotImportedToXledger })
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
        findContractById: _findContractById = findContractById,
        isRecipientImportedToXledger: _isRecipientImportedToXledger = isRecipientImportedToXledger,
        logger: _logger = logger,
    } = deps

    const csvDataArray = []
    // Invoices held back because their recipient is not in Xledger yet - reported on the Teams card.
    const skippedNotImportedToXledger = []

    for (const invoice of invoices) {
        // Checked before the løpenummer fallback below, so a held-back invoice does not get a serial
        // number written to it on every run while it waits for the flag to flip.
        const { imported, skip } = await resolveRecipientImportStatus(invoice, {
            findContractById: _findContractById,
            isRecipientImportedToXledger: _isRecipientImportedToXledger,
        })
        if (!imported) {
            skippedNotImportedToXledger.push(skip)
            _logger('warn', ['handleExtraInvoice', `Invoice with _id: ${invoice._id} was left alone: ${skip.reason}. Status stays 'Ikke Fakturert' and it will be retried on the next run.`])
            continue // Skip this document
        }

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
   return await _generateInvoiceImportFile('extraInvoice', csvDataArray, { skippedNotImportedToXledger })
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
    resolveRecipientImportStatus,
}




