const { logger } = require("@vtfk/logger")
const {createTestDataSigned, createTestDataUnSigned} = require("./createTestData.js")
const { postFormInfo } = require('./queryMongoDB.js')

const logPrefix = 'postTestDataToDB'

const postSignedForms = async (numberOfSignedForms) => {
    for (let i = 0; i < numberOfSignedForms; i++) {
        logger('info', [logPrefix, `Posting signed form ${i+1} of ${numberOfSignedForms} to DB`])
        const formInfo = createTestDataSigned()
        try {
            await postFormInfo(formInfo, true)
        } catch (error) {
            logger('error', [logPrefix, 'Error posting signed form', error])
        }
    }
}

const postUnSignedForms = async (numberOfUnSignedForms) => {
    for (let i = 0; i < numberOfUnSignedForms; i++) {
        logger('info', [logPrefix, `Posting unsigned form ${i+1} of ${numberOfUnSignedForms} to DB`])
        const formInfo = createTestDataUnSigned()
        try {
            await postFormInfo(formInfo, true)
        } catch (error) {
            logger('error', [logPrefix, 'Error posting unsigned form', error])
        }
    }
}

module.exports = { postSignedForms, postUnSignedForms }
