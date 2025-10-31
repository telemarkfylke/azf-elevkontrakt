const { teams } = require("../../../../config.js")
const { logger } = require("@vtfk/logger")
const { getDocuments, updateDocument } = require("../queryMongoDB")
const { promises: fs } = require("fs")
const { readAndParseCSV } = require("../../helpers/readAndParseCSV")
const axios = require('axios').default

 /**
 * Example of the data structure of the csvRows:
 * [
 *      {
 *          "Assigned Team": "Bamble videregående skole",
 *          "Created Date Time": "15.08.2025 14:14:35",
 *          "Email": "test24021@skole.telemarkfylke.no",
 *          "Full Name": "Test Tester Testesen"
 *      }
 * ]
 */
/**
 * 
 * @param {Array} csvRows | Array of objects representing the rows to be added to the CSV file
 * @param {string} type | 'utlevering' | 'innlevering'
 */
const updateStudentCSVFile = async (csvRows, type) => {
    if(!type) {
        logger("error", ["updateStudentCSVFile", "Type parameter is required"])
        throw new Error("Type parameter is required")
    }
    if(!csvRows || csvRows.length === 0) {
        logger("info", [loggerPrefix, "No CSV rows provided to update the file"])
        return 0
    }

    const loggerPrefix = "updateStudentCSVFile - " + (type)
    const csvFilePath = `./src/data/pc_files/${type}_matchNotFoundInMongoDB.csv`
   
    // Check if the csvFilePath is defined
    if(csvFilePath === undefined || csvFilePath === null || csvFilePath === '') {
        logger("error", [loggerPrefix, "CSV file path is not defined"])
        throw new Error("CSV file path is not defined")
    }
    // Check if the file exists, if not, create it
    try {
        await fs.access(csvFilePath)
    } catch (error) { 
        logger("info", [loggerPrefix, "CSV file does not exist, creating a new one"])
        const header = Object.keys(csvRows[0]).join(";") + "\n"
        await fs.writeFile(csvFilePath, header, "utf-8")
    }

    // With the new rows, we will update the CSV file
    try {
        const existingData = await readAndParseCSV(csvFilePath)
        // Check if any of the rows already exist in the CSV file
        // Filter out the rows that exist in existingRows from csvRows using the "Email" field
        const existingRowsEmail = existingData.map(row => row["Email"].trim().toLowerCase())
        const newRows = csvRows.filter(row => !existingRowsEmail.includes(row["Email"].trim().toLowerCase()))
        // Add the new rows to the existing data if they are not already present
        if (newRows.length === 0) {
            logger("info", [loggerPrefix, "No new rows to add to CSV"])
        } else {
            const header = Object.keys(csvRows[0]).join(";")
            const rows = newRows.map(row => Object.values(row).join(";")).join("\n")
            if (existingData.length === 0) {
                logger("info", [loggerPrefix, `Creating new CSV file with ${newRows.length} rows`])
                // Write the new data to the CSV file
                await fs.writeFile(csvFilePath, `${header}\n${rows}`, "utf-8")
            } else {
                const updatedData = `${existingData.map(row => Object.values(row).join(";")).join("\n")}\n${rows}`;
                logger("info", [loggerPrefix, `Updating CSV file with ${newRows.length} new rows`])
                // Write the updated data to the CSV file
                await fs.writeFile(csvFilePath, `${header}\n${updatedData}`, "utf-8")
            }
        }
    } catch (error) {
        logger("error", [loggerPrefix, "Failed to update CSV file", error && error.message ? error.message : error])
        throw error
    }
}

/**
 * 
 * @param {Object} message | { updateCount, notFoundCount, updateCountOldFile, notFoundCountOldFile }
 * @param {string} type | 'utlevering' | 'innlevering'
 */
const sendTeamsMessage = async (message, type) => {
    const loggerPrefix = "sendTeamsMessage"
    const { updateCount, notFoundCount, updateCountOldFile, notFoundCountOldFile } = message
    let pcStatusType = ""
    let pcStatus = ""
    if(type === 'utlevering') {
        logger("info", [loggerPrefix, "Sending Teams message about PC status update (utlevering)"])
        pcStatusType = "PC-utlevering"
        pcStatus = "PC-utleveringsstatus"

    } else {
        logger("info", [loggerPrefix, "Sending Teams message about PC status update (innlevering)"])
        pcStatusType = "PC-innlevering"
        pcStatus = "PC-innleveringsstatus"
    }
    const teamsMsg = {
            type: 'message',
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    contentUrl: null,
                    content: {
                        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                        type: 'AdaptiveCard',
                        version: '1.5',
                        msteams: { width: 'full' },
                        body: [
                            {
                                type: 'TextBlock',
                                text: `Statusrapport - azf-elevkontrakt - Oppdatering av ${pcStatusType}`,
                                wrap: true,
                                style: 'heading',
                            },
                            {
                                type: 'TextBlock',
                                text: `**${updateCount}** dokument(er) er oppdatert med ny ${pcStatus}`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'TextBlock',
                                text: `**${notFoundCount}** Elev(er) ble ikke funnet i databasen, men ble funnet i CSV-filen`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'TextBlock',
                                text: `**${updateCountOldFile}** dokument(er) er oppdatert med ny ${pcStatus} fra gammel fil`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'TextBlock',
                                text: `**${notFoundCountOldFile}** Elev(er) ble ikke funnet i databasen fra gammel fil`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'FactSet',
                                facts: []
                            },
                            {
                                type: 'Image',
                                url: 'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3ZDFsOTUybmJiZzJ1MGw4ZDg5bG9paHZzNTk1NGs3OTN5MWhtMDRsNCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/Hdgh69gIXYatwqikAU/giphy.gif',
                                horizontalAlignment: 'Center'
                            }
                        ]
                    }
                }
            ]
        }
    const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
    const postStatus = await axios.post(teams.webhook, teamsMsg, { headers })
    return postStatus
}

/**
 * Update the PC status for a student
 * @param {string} type | 'utlevering' | 'innlevering'
 * @returns {Promise<number>} | Number of documents updated
 */
const updateStudentPCStatus = async (type) => {
    if(!type || (type !== 'utlevering' && type !== 'innlevering')) {
        logger("error", ["updateStudentPCStatus", "Type parameter is required and must be either 'utlevering' or 'innlevering'"])
        throw new Error("Type parameter is required and must be either 'utlevering' or 'innlevering'")
    }
    const loggerPrefix = "updateStudentPCStatus" + (type)
    logger("info", [loggerPrefix, `Starting update of student PC status - Type: ${type}`])
    let query = {}
    let csvFilePath = ''
    let csvFileName = ''
    let oldDataFilePath = ''
    if(type === 'utlevering') {
        query = {
            "pcInfo.released": "false",
        }
        csvFilePath = `${process.env.SERVER_PATH_UTLEVERING}/utleveringer.csv` // The CSV file with the PC status updates
        csvFileName = 'utleveringer.csv'
        oldDataFilePath = './src/data/pc_files/utlevering_matchNotFoundInMongoDB.csv'
    } else if (type === 'innlevering') {
        query = {
            "pcInfo.released": "true",
            "pcInfo.returned": "false",
        }
        csvFilePath = `${process.env.SERVER_PATH_UTLEVERING}/innleveringer.csv` // The CSV file with the PC status updates
        csvFileName = 'innleveringer.csv'
        oldDataFilePath = './src/data/pc_files/innlevering_matchNotFoundInMongoDB.csv'
    }

    // Fetch all documents that need to be updated
    const documents = await getDocuments(query, 'regular')
    if (!documents || !documents.result || documents.result.length === 0) {
        logger("info", [loggerPrefix, `No documents found to update PC status - Type: ${type}`])
        return 0
    }

    // const csvFilePath = './src/data/test.csv' // For testing purposes, use the test.csv file'
    // Read the CSV file and parse it
    const csvRows = await readAndParseCSV(csvFilePath)
    if (!csvRows || csvRows.length === 0) {
        logger("info", [loggerPrefix, "No CSV rows found to match with MongoDB documents"])
        return 0
    }

    // For each csvRow, check if the student exists in the database and update the PC status. 
    // If the student dont match create a new csv document with the student data. If the csv document already exists, update the csv document with the new data.
    let updateCount = 0
    let updateCountOldFile = 0
    let notFoundCountOldFile = 0
    let notFoundCount = 0
    let csvRowsForMatchNotFoundInMongoDB = []
    let csvRowsToRemoveFromOldFile = []

    // UPN -> document matching
    const docByUpn = new Map(
        documents.result
            .filter(d => d && d.elevInfo && typeof d.elevInfo.upn === "string")
            .map(d => [d.elevInfo.upn.trim().toLowerCase(), d])
    )
    let releaseDate = new Date()
    releaseDate.setDate(releaseDate.getDate() - 1)

    // Iterate CSV rows and match against MongoDB documents
    for (const row of csvRows) {
        const email = (row["Email"] || "").trim().toLowerCase()
        if (!email) {
            logger("info", [loggerPrefix, "CSV row missing Email field, skipping"])
            continue
        }

        let updateData = {}
        if (type === 'utlevering') {
            updateData = {"pcInfo.released": "true", "pcInfo.releasedDate": releaseDate, "pcInfo.releaseBy": row["Assigned Team"]}
        } else if (type === 'innlevering') {
            updateData = {"pcInfo.returned": "true", "pcInfo.returnedDate": new Date(), "pcInfo.returnedRegisteredBy": row["Assigned Team"]}
        }

        const matchedDoc = docByUpn.get(email)

        if (matchedDoc) {
            updateCount++
            // Update the PC status in the matched document
            logger("info", [loggerPrefix, `Updating the PC status for ${updateCount} students`])
            try {
                await updateDocument(matchedDoc._id, updateData, 'regular')
                logger("info", [loggerPrefix, `Updated PC status for student with UPN-startswith: ${email.split('@')[0]}`])
            } catch (error) {
                logger("error", [loggerPrefix, "Error updating PC status for students", error && error.message ? error.message : error])
                throw error
            }
        } else {
            // Found in CSV, but not found in MongoDB
            // logger("info", [loggerPrefix, `Student with UPN ${email} from CSV not found in MongoDB`])
            const newRow = {
                "Assigned Team": row["Assigned Team"] || "",
                "Created Date Time": row["Created Date Time"] || "",
                "Email": row["Email"] || "",
                "Full Name": row["Full Name"] || ""
            }
            csvRowsForMatchNotFoundInMongoDB.push(newRow)
            notFoundCount++
        }
    }

    // We dont need this part anymore, but might be useful later

    // Before updating the "matchNotFoundInMongoDB.csv" file with new rows, check if any existing rows now match update the mongoDb document and remove the corresponding rows from the CSV.
    // Read and parse the existing CSV file
    // const oldDataFromMatchNotFoundInMongoDB = await readAndParseCSV(oldDataFilePath)
    // Check if the current row exists in the old data using the "Email" field
    // for (const row of oldDataFromMatchNotFoundInMongoDB) {
    //     const email = (row["Email"] || "").trim().toLowerCase()
    //     if (!email) {
    //         logger("info", [loggerPrefix, "Old CSV row missing Email field, skipping"])
    //         continue
    //     }
    //     let updateData = {}
    //     if (type === 'utlevering') {
    //         updateData = {"pcInfo.released": "true", "pcInfo.releasedDate": releaseDate, "pcInfo.releaseBy": row["Assigned Team"]}
    //     } else if (type === 'innlevering') {
    //         updateData = {"pcInfo.returned": "true", "pcInfo.returnedDate": new Date(), "pcInfo.returnedRegisteredBy": row["Assigned Team"]}
    //     }
    //     const matchedDoc = docByUpn.get(email)
    //     if (matchedDoc) {
    //         updateCountOldFile++
    //         // Update the PC status in the matched document
    //         logger("info", [loggerPrefix, `Updating the PC status for ${updateCount} students`])
    //         try {
    //             await updateDocument(matchedDoc._id, updateData, 'regular')
    //             logger("info", [loggerPrefix, `Updated PC status for student with UPN-startswith: ${email.split('@')[0]}`])
    //         } catch (error) {
    //             logger("error", [loggerPrefix, "Error updating PC status for students", error && error.message ? error.message : error])
    //             throw error
    //         }
    //         // If matched find the row in oldDataFromMatchNotFoundInMongoDB and remove it from the csvRowsForMatchNotFoundInMongoDB array
    //         const index = oldDataFromMatchNotFoundInMongoDB.findIndex(r => r["Email"].trim().toLowerCase() === email)
    //         if (index !== -1) {
    //             csvRowsToRemoveFromOldFile.push(oldDataFromMatchNotFoundInMongoDB[index])
    //         }
    //     } else {
    //         // Found in CSV, but not found in MongoDB
    //         // logger("info", [loggerPrefix, `Student with UPN ${email} from CSV not found in MongoDB`])
    //         const newRow = {
    //             "Assigned Team": row["Assigned Team"] || "",
    //             "Created Date Time": row["Created Date Time"] || "",
    //             "Email": row["Email"] || "",
    //             "Full Name": row["Full Name"] || ""
    //         }
    //         csvRowsForMatchNotFoundInMongoDB.push(newRow)
    //         notFoundCountOldFile++
    //     }
    // }

    // // In csvRowsToRemoveFromOldFile we have the rows that were found in MongoDB when checking the old CSV file. Remove them from the file matchNotFoundInMongoDB.csv
    // if (csvRowsToRemoveFromOldFile.length > 0) {
    //     logger("info", [loggerPrefix, `Removing ${csvRowsToRemoveFromOldFile.length} rows from the old CSV file "${type}_matchNotFoundInMongoDB.csv"`])
    //     // Read the existing CSV file
    //     const existingData = await readAndParseCSV(oldDataFilePath)
    //     // Filter out the rows that are in csvRowsToRemoveFromOldFile
    //     const updatedData = existingData.filter(row => !csvRowsToRemoveFromOldFile.some(r => r["Email"].trim().toLowerCase() === row["Email"].trim().toLowerCase()))
    //     // Write the updated data back to the CSV file
    //     const header = Object.keys(updatedData[0] || {}).join(";")
    //     const rows = updatedData.map(row => Object.values(row).join(";")).join("\n")
    //     await fs.writeFile(oldDataFilePath, `${header}\n${rows}`, "utf-8")
    // }

    // END OF UNUSED PART
    
    // We still want to update the csv file with the new rows that were not found in MongoDB. 
    // If there are rows that were not found in MongoDB, update the CSV file
    if (csvRowsForMatchNotFoundInMongoDB.length > 0) {
        await updateStudentCSVFile(csvRowsForMatchNotFoundInMongoDB, type)
        logger("info", [loggerPrefix, `Updated CSV file "${type}_matchNotFoundInMongoDB.csv" with ${csvRowsForMatchNotFoundInMongoDB.length} rows that were not found in the database`])
    }

    // Then move the csv file "csvFilePath" to the finished folder
    try {
        const finishedFilePath = `./src/data/finished/${new Date().toISOString().replace(/[:.]/g, '-')}-${csvFileName}`
        // Move the CSV file to the finished folder
        logger("info", [loggerPrefix, `Moving the CSV file to the finished folder: ${finishedFilePath}`])
        // Check if the finished folder exists, if not, create it
        await fs.mkdir('./src/data/finished', { recursive: true }) 
        // Rename the file to move it to the finished folder
        await fs.copyFile(csvFilePath, finishedFilePath)
        logger("info", [loggerPrefix, `Moved the CSV file to the finished folder: ${finishedFilePath}`])
        
    } catch (error) {
        logger("error", [loggerPrefix, "Error moving the CSV file to the finished folder", error && error.message ? error.message : error])
        throw error
    }

    logger("info", [loggerPrefix, `Not found ${notFoundCount} students in the database, but found in the CSV file`])

    await sendTeamsMessage({ updateCount, notFoundCount, updateCountOldFile, notFoundCountOldFile }, type)
    
    return { updateCount, notFoundCount, updateCountOldFile, notFoundCountOldFile }
}

module.exports = {
    updateStudentPCStatus
}