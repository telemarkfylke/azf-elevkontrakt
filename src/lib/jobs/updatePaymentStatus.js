const { getDocuments } = require('../jobs/queryMongoDB.js');

const updatePaymentStatus = async () => {
    const query = { fakturaInfo: { rate1: { status: "Fakturert" } } }
    const documents = await getDocuments(query, 'regular')
    return documents
}

module.exports = {
    updatePaymentStatus,
}