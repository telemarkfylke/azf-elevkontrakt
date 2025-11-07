const { logger } = require('@vtfk/logger')
const { email } = require('../../../config.js')
const { default: axios } = require('axios')
require('dotenv').config()

/**
 * 
 * @param {Array<String>} to | Array of email addresses | The recipients of the email e.g. ['recipient@example.com', 'recipient2@example.com']
 * @param {String} from | Sender email address | The email address from which the email is sent e.g. 'sender@example.com'
 * @param {String} subject | Email subject | The subject line of the email
 * @param {String} html | Email body (HTML) | This is the main content of the email
 * @param {Array<Object>} attachments | Array of attachments | Each attachment should be an object with 'name', 'data', and 'type' properties e.g. [{ name: 'file.csv', data: 'base64encodeddata', type: 'text/csv' }]
 * @returns 
 */
const sendEmail = async (to, from, subject, html, attachments) => {
    // Type check
    if(to && !Array.isArray(to)) {
        throw new Error('Parameter "to" must be an array')
    }
    if(!from || !subject) {
        throw new Error('Parameters "from" and "subject" are required')
    }
    if(from && typeof from !== 'string') {
        throw new Error('Parameter "from" must be a string')
    }
    if(subject && typeof subject !== 'string') {
        throw new Error('Parameter "subject" must be a string')
    }
    if(attachments && !Array.isArray(attachments)) {
        throw new Error('Parameter "attachments" must be an array')
    }
    if(attachments) {
        attachments.forEach(attachment => {
            if(!attachment.name || !attachment.data || !attachment.type) {
                throw new Error('Each attachment must have "name", "data", and "type" properties')
            }
        })
    }

    // Build email data object
    const emailData = {
        to: to,
        subject: subject,
        from: from,
        html: html,
        attachments: attachments || []
    }
    // Send email
    try {
        const response = await axios.post(`${email.url}/send`, emailData, {
            headers: {
                "x-functions-key": `${email.xFunctionsKey}`
            }
        })
        return response.data
    } catch (error) {
        logger('error', 'Error sending email', error)
        throw error
    }
}

module.exports = {
    sendEmail
}   