const axios = require('axios');
const fs = require('fs');
const { xledger } = require('../../../config');
const { logger } = require('@vtfk/logger');
const logPrefix = 'queryXledger'


const queryXledger = async (request, fileName) => {
    let headers = {}
    if(fileName) {
        headers = {
            filename: fileName,
            'Content-Type': 'application/octet-stream'
        }
    } else {
        headers = {
            'Content-Type': 'application/json'
        }
    }

    const xledgerRequest = {
        method: request.method,
        url: xledger.url + request.path,
        data: request.body,
        headers
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
/**
 * 
 * @param {string} fileType | "SO01b_2" for Invoice base transactions, SL04-SYS for Subledger import 
 * @param {string} pathToFileForImport | Path to the file to be imported
 */
const fileImport = async (fileType, pathToFileForImport, fileName) => {
    // Read file and convert array buffer
    function toArrayBuffer(filePath) {
        const fileBuffer = fs.readFileSync(filePath);
        return Uint8Array.from(fileBuffer);
    }

    const request = {
        method: 'POST',
        path: `/import/${fileType}/files`,
        body: toArrayBuffer(pathToFileForImport)
    }

    try {
        const result = await queryXledger(request, fileName)
        return result.data
    } catch (error) {
         logger('error', [logPrefix, `Error importing file: ${fileName}`, error])
    }
}


module.exports = {
    getSalesOrders,
    fileImport,
    getOrderStatuses
}