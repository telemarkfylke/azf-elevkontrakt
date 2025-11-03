const axios = require('axios');
const { xledger } = require('../../../config');
const { logger } = require('@vtfk/logger');

const queryXledger = async (request) => {

    const xledgerRequest = {
        method: request.method,
        url: xledger.url + request.path,
        data: request.body,
        headers: {
            'Content-Type': 'application/json'
        }
    }

    try {
        return await axios.request(xledgerRequest)
    } catch (error) {
        console.log(JSON.stringify(error))
    }
}

const getSalesOrders = async (extOrderNumbers, limit) => {
    const request = {
        method: 'POST',
        path: '/search/salesorders?limit=' + limit,
        body: {
            extOrderNumbers: extOrderNumbers
        }
    }

    try {
        const res = await queryXledger(request)
        return res.data.rows
    } catch (error) {

    }
}


module.exports = {
    getSalesOrders
}