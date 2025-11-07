const axios = require('axios');
const { xledger } = require('../../../config');
const { logger } = require('@vtfk/logger');
const logPrefix = 'queryXledger'

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
        logger('error', [logPrefix, 'Error fetching data from xledger api', error])
    }
}

const getSalesOrders = async (extOrderNumbers) => {
    // We really dont want to use paging, since it is dangerous if the dataset changes inbetween pages. So we
    const limit = (extOrderNumbers.length * 4)

    const request = {
        method: 'POST',
        path: '/search/salesorders?limit=' + limit,
        body: {
            extOrderNumbers: extOrderNumbers
        }
    }

    try {
        let res = await queryXledger(request)
        const rows = []
        let pagesFailsafe = 0  // Just to make sure we don't end in an eternal request loop because we did something wrong.
        rows.push(...res.data.rows)
        while (res.data.nextPage !== null && pagesFailsafe < 10) {
            request.path = '/search/salesorders?limit=' + res.data.nextPage.limit + '&cursor=' + res.data.nextPage.cursor + '&direction=' + res.data.nextPage.direction,
                res = await queryXledger(request)
            rows.push(...res.data.rows)
            pagesFailsafe++
        }
        return rows
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching salesorders', error])
    }
}

const getOrderStatuses = async (extOrderNumbers) => {
    const request = {
        method: 'POST',
        path: '/search/orderstatus',
        body: {
            extOrderNumbers: extOrderNumbers
        }
    }

    try {
        let res = await queryXledger(request)
        return res.data.rows
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching orderStatus', error])
    }
}


module.exports = {
    getSalesOrders,
    getOrderStatuses
}