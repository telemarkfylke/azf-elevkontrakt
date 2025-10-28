const { getDocuments, postSerialNumber } = require('../jobs/queryMongoDB.js');


/**
 * Get the latest serial number from the database
 * 
 * Max length of the serial number is 25 characters, must be type String.
 *
 * Løpenummer variable structure:
 * - System: Describes the system generating the serial number, e.g., "AZF".
 * - Iteration Number: A sequential number that increments with each new serial number generated within the same year and rate.
 * - Rate Number: Indicates the rate associated with the serial number, e.g., "1" for the first rate, "2" for the second rate, etc.
 * - Year: The current year when the serial number is generated.
 * - Random String: A random alphanumeric string to ensure uniqueness.
 * 
 * Full structure:
 * - Format: [System]-[Iteration Number]-[Rate Number]-[Year]-[Random String]
 * - Example: AZF-0000001-1-2024-x7y9z3
 * - Separator: A hyphen ("-") is used to separate the different components of the serial number.
 * 
 */

const randomString = (l) => {
    let s = '';
    const numbers = '0123456789';
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const chars = numbers + letters;
    for (let i = 0; i < l; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
}

/**
 * Generates a new serial number based on the provided rate number.
 * @param {*} rateNumber 
 * @returns {Promise<String>} - The generated serial number.
 */
const generateSerialNumber = async (rateNumber) => {
    const currentYear = new Date().getFullYear();
    const system = 'JOT';
    const rateNum = rateNumber.toString();
    const randomStr = randomString(6);
    let iterationNumber = 1;

    // To get the correct iteration number, we need to query the database for the latest serial number
    const query = {}
    const result = await getDocuments(query, 'løpenummer')
    if(result.status === 404) {
        iterationNumber = 1;
    } else {
        const latestSerialNumberEntry = result.result[0]
        const latestSerialNumber = latestSerialNumberEntry.iterationNumber
        iterationNumber = latestSerialNumber + 1
    }
    const serialNumber = `${system}-${String(iterationNumber).padStart(9, '0')}-${rateNum}-${currentYear}-${randomStr}`

    // Save the new serial number to the database
    const serialNumberEntry = {
        iterationNumber: iterationNumber,
        currentYear: currentYear,
        rateNumber: rateNum,
        randomString: randomStr,
        system: system,
        serialNumber: serialNumber,
        createdTimeStamp: new Date()
    }

    // Insert the new serial number entry into the database
    await postSerialNumber(serialNumberEntry)

    return serialNumber;
}

module.exports = {
    generateSerialNumber
}  