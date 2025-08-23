// Updates student information in the database

/**
 * Info to be updated:
 *  elevInfo.
 *  - navn
 *  - fornavn
 *  - etternavn
 *  - upn
 *  - skole
 *  - klasse
 *  - trinn
 * 
 *  skoleOrgNr
 */

/**
 * Steps:
 * 1. Query mongoDB for all the documents.
 * 2. For each document (using fnr):
 *   - Check if the fnr in the document exists in FINT. (Person is still a student)
 *   - If it exists, update the document with the new information from FINT. (elevInfo).
 *   - Then if elevInfo.skole !== fintData.skole, update the document with the new skoleOrgNr.
 *   - If it does not exist, move the document to the history database. Add the document-id to an array and send the array as a report to teams using a teams webhook.
 *  
 */

const { getDocuments, updateDocument } = require('./queryMongoDB')
const { teams } = require('../../../config.js')
const { logger } = require('@vtfk/logger')
const { student } = require('./queryFINT')
const axios = require('axios').default

const updateStudentInfo = async () => {
    const loggerPrefix = 'updateStudentInfo'
    const updatedDocuments = []
    const movedDocuments = []
    const report = {
        updateCount: 0,
        historyCount: 0,
        newStudentsNotFoundInFINTCount: 0,
        updatedDocuments: updatedDocuments,
        movedDocuments: movedDocuments
    }

    logger('info', [loggerPrefix, 'Starting to update student information'])
    const documents = await getDocuments({"elevInfo.skole": "Notodden videregående skole"}, false)
    if(documents.result.length === 0) { return report } // If no documents are found, we can return the report
    for (const doc of documents.result) {
        const updateData = {}
        const fnr = doc.elevInfo.fnr
        const fintData = await student(fnr, false, true)
        if (fintData.status === 404 && fintData.message === 'Personen er ikke en student') {
            // If the student is not found, we can handle it here
            // Check if the field "notFoundInFINT" object exists in the document
            if (!doc.notFoundInFINT.date) {
                // If it does not exist, create it
                updateData["notFoundInFINT.date"] = new Date() // Set the date to the current date
                updateData["notFoundInFINT.message"] = 'Student not found in FINT'
                // Update the document with the new field
                logger('info', [loggerPrefix, `Document with _id ${doc._id} not found in FINT, updating document`])
                report.newStudentsNotFoundInFINTCount += 1
                updatedDocuments.push(doc._id)
                await updateDocument(doc._id, updateData)
            } else {
                // Check if the date is more than 10 days old.
                const tenDaysAgo = new Date();
                tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
                if (doc.notFoundInFINT.date < tenDaysAgo) {
                    // If its more than 10 days old, move the document to the history database
                    logger('info', [loggerPrefix, `Document with _id ${doc._id} not found in FINT for more than 10 days, moving to history database`])
                    movedDocuments.push(doc._id)
                    report.historyCount += 1
                    // Move the document to the history database
                    // TODO: Implement the logic to move the document to the history database
                }
            }
        } else if (fintData.status === 500 || fintData.status === 400) {
            // If there is an error fetching the student data, we can log it
            logger('error', [loggerPrefix, `Error fetching student data for document ${doc._id}`, fintData])
            continue // Skip to the next document
        } else if (fintData?.elevnummer !== '' || fintData?.elevnummer !== null || fintData?.elevnummer !== undefined) {
            // If the student is found, we can update the document if necessary
            // Replace navn, fornavn, etternavn, upn.
            if(fintData.navn && fintData.navn !== doc.elevInfo.navn) {
                updateData["elevInfo.navn"] = fintData.navn
            } else {
                logger('info', [loggerPrefix, `Navn not found in fintData for document or navn is an equal match ${doc._id}`])
            }
            if(fintData.fornavn && fintData.fornavn !== doc.elevInfo.fornavn) {
                updateData["elevInfo.fornavn"] = fintData.fornavn
            } else {
                logger('info', [loggerPrefix, `Fornavn not found in fintData for document or fornavn is an equal match ${doc._id}`])
            }
            if(fintData.etternavn && fintData.etternavn !== doc.elevInfo.etternavn) {
                updateData["elevInfo.etternavn"] = fintData.etternavn
            } else {
                logger('info', [loggerPrefix, `Etternavn not found in fintData for document or etternavn is an equal match ${doc._id}`])
            }
            if(fintData.upn && fintData.upn !== doc.elevInfo.upn) {
                updateData["elevInfo.upn"] = fintData.upn
            } else {
                logger('info', [loggerPrefix, `UPN not found in fintData for document or UPN is an equal match ${doc._id}`])
            }
            // Find the first active elevforhold and update elevInfo field if it is not a match with the fintData
            const fintElevForhold = fintData.elevforhold.find(ef => ef.aktiv === true) 
            // Replace skole, klasse, trinn if fintElevForhold is found and if it is not a match with the document.elevInfo.skole, document.skoleOrgNr, document.elevInfo.klasse, document.elevInfo.trinn
            if(fintElevForhold !== undefined) {
                // Check if values are not null or undefined before updating
                if (fintElevForhold.skole.navn && fintElevForhold.skole.navn !== doc.elevInfo.skole) {
                    updateData["elevInfo.skole"] = fintElevForhold.skole.navn
                    // Since we updated the school, we also need to update the skoleOrgNr
                    updateData["skoleOrgNr"] = fintElevForhold.skole.organisasjonsnummer
                } else {
                    logger('info', [loggerPrefix, `Skole not found in fintElevForhold for document or skole is an equal match ${doc._id}`])
                }
                if (fintElevForhold.basisgruppemedlemskap) {
                    const fintElevBasisgruppemedlemskap = fintElevForhold.basisgruppemedlemskap.find(bas => bas.aktiv === true)
                    if (fintElevBasisgruppemedlemskap) {
                        // Replace klasse if it is not a match with the document.elevInfo.klasse and trinn if it is not a match with the document.elevInfo.trinn
                        if(fintElevBasisgruppemedlemskap.navn !== doc.elevInfo.klasse) {
                            updateData["elevInfo.klasse"] = fintElevBasisgruppemedlemskap.navn
                        } else {
                            logger('info', [loggerPrefix, `Klasse not found in fintElevForhold for document or klasse is an equal match ${doc._id}`])
                        }
                        if(fintElevBasisgruppemedlemskap.trinn !== doc.elevInfo.trinn) {
                            updateData["elevInfo.trinn"] = fintElevBasisgruppemedlemskap.trinn
                        } else {
                            logger('info', [loggerPrefix, `Trinn not found in fintElevForhold for document or trinn is an equal match ${doc._id}`])
                        }
                    }
                } else {
                    logger('error', [loggerPrefix, `Basisgruppemedlemskap not found in fintElevForhold for document ${doc._id}`])
                }
            } else {
                logger('error', [loggerPrefix, `No active elevforhold found for document ${doc._id}, but elev was found in FINT`])
            }
             // If there are any updates, we can update the document
            if (Object.keys(updateData).length > 0) {
                updatedDocuments.push(doc._id)
                report.updateCount += 1
                updateData["notFoundInFINT"] = {} // Reset notFoundInFINT field
                updateData["lastFINTSyncTimeStamp"] = new Date() // Update the lastFINTSyncTimeStamp to the current date
                logger('info', [loggerPrefix, `Updating document ${doc._id} with new data`])
                await updateDocument(doc._id, updateData)
            } else {
                logger('info', [loggerPrefix, `No updates needed for document ${doc._id}`])
            }
        } else {
            // If there is an error, we can log it
            logger('error', [loggerPrefix, `Error fetching student data for document ${doc._id}`, fintData])
            continue // Skip to the next document
        }
    }
    logger('info', [loggerPrefix, `Finished updating student information. Updated ${report.updateCount} documents, moved ${report.historyCount} documents to history database, ${report.newStudentsNotFoundInFINTCount} new students not found in FINT`])
    if (report.updateCount > 0 || report.historyCount > 0 || report.newStudentsNotFoundInFINTCount > 0) {
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
                                text: 'Statusrapport - azf-elevkontrakt - Oppdatering av studentinformasjon',
                                wrap: true,
                                style: 'heading',
                            },
                            {
                                type: 'TextBlock',
                                text: `**${report.updateCount}** dokument(er) er oppdatert med ny studentinformasjon`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'FactSet',
                                facts: report.updatedDocuments.map(id => ({ title: 'Document ID', value: id }))
                            },
                            {
                                type: 'TextBlock',
                                text: `**${report.historyCount}** dokument(er) er flyttet til historikk-databasen`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'FactSet',
                                facts: report.movedDocuments.map(id => ({ title: 'Document ID', value: id }))
                            },
                            {
                                type: 'TextBlock',
                                text: `**${report.newStudentsNotFoundInFINTCount}** nye student(er) ble ikke funnet i FINT`,
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
                                url: 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExYzEzZDlqYjVmaHhjbnZodjJ1dHV0aWU3YnZ5d3ZycTQ3d2RrNTUyNyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/Rgt5pP4DoFGdt2Dcp3/giphy.gif',
                                horizontalAlignment: 'Center'
                            }
                        ]
                    }
                }
            ]
        }
        const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
        await axios.post(teams.webhook, teamsMsg, { headers })
    }
    return report
}

module.exports = {
    updateStudentInfo,
}