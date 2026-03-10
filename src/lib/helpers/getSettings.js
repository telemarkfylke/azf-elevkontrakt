const { getDocuments } = require("../jobs/queryMongoDB")

/**
 *  Fetches the price list and exceptions for the current year from the database.
 * @returns {Object} - An object containing the prices, exceptions from regular prices, and exceptions from the invoice flow.
 */
const getThisYearsPriceList = async () => {
  const settings = await getDocuments({}, 'settings')
  return { 
    prices: settings.result[0].prices, 
    exceptionsFromRegularPrices: settings.result[0].exceptionsFromRegularPrices, 
    exceptionsFromInvoiceFlow: settings.result[0].exceptionsFromInvoiceFlow 
  } || {}
}

module.exports = {
    getThisYearsPriceList
}