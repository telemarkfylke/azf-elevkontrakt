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

const { getDocuments, updateDocument, moveAndDeleteDocument } = require('./queryMongoDB')
const { teams } = require('../../../config.js')
const { logger } = require('@vtfk/logger')
const { student } = require('./queryFINT')
const axios = require('axios').default

const updateStudentInfo = async () => {
    const loggerPrefix = 'updateStudentInfo'
    const updatedDocuments = []
    const movedDocuments = []
    const studentsWithoutActiveElevforhold = []
    const pcNotDeliveredHistoryCountOrRatesNotPaied = [] 
    // Report object to be returned at the end of the function
    // Also used in the teams message
    const report = {
        totalNumberOfDocuments: 0,
        updateCount: 0,
        historyCount: 0,
        pcNotDeliveredHistoryCountOrRatesNotPaiedCount: 0, // Count of documents moved to history because pcInfo.released === "false" or pcInfo.released === "true" and pcInfo.returned === "true"
        newStudentsNotFoundInFINTCount: 0, // Count of new students not found in FINT during this run "404 Not Found" - "No student with the provided identificator found in FINT"
        studentsWithoutActiveElevforholdCount: 0, // Count of students found in FINT but without any active elevforhold
        updatedDocuments: updatedDocuments,
        movedDocuments: movedDocuments,
        studentsWithoutActiveElevforhold: studentsWithoutActiveElevforhold
    }

    const moveToHistoryDatabase = async (doc, updateData) => {
        // Check if the field "notFoundInFINT" object exists in the document
        if (!doc.notFoundInFINT?.date) {
            // If it does not exist, create it
            updateData["notFoundInFINT.date"] = new Date() // Set the date to the current date
            updateData["notFoundInFINT.message"] = 'Student not found in FINT'
            // Update the document with the new field
            logger('info', [loggerPrefix, `Document with _id ${doc._id} not found in FINT, updating document`])
            updatedDocuments.push(doc._id)
            await updateDocument(doc._id, updateData, 'regular')
        } else {
            // Check if the date is more than 5 days old.
            const date = new Date();
            date.setDate(date.getDate() - 5);
            if (doc.notFoundInFINT.date < date) {
                // If its more than 5 days old, move the document to the history database
                logger('info', [loggerPrefix, `Document with _id ${doc._id} not found in FINT for more than 5 days, moving to history database`])
                // Only move the document if the student have returned the pc or bought it out, and have no rates with status "Ikke Fakturert"
                if((doc.pcInfo?.returned === "true" || doc.pcInfo?.boughtOut === "true") && !doc.rates?.some(rate => rate.status === "Ikke Fakturert")) {
                    movedDocuments.push(doc._id)
                } else {
                    report.pcNotDeliveredHistoryCountOrRatesNotPaiedCount += 1
                    pcNotDeliveredHistoryCountOrRatesNotPaied.push(doc._id)
                }
                // Move the document to the history database
                if (movedDocuments.length > 0) {
                    try {
                        // If its time to move the student to the history database, check if the pc status. 
                        // The student should only be moved if the pc is returned or not delivered to the student. 
                        // pcInfo.released === "false" or pcInfo.released === "true" and pcInfo.returned === "true"
                        // if (doc.pcInfo?.released === "true" && doc.pcInfo?.returned !== "true") {
                        //     logger('warn', [loggerPrefix, `Document with _id ${doc._id} has pcInfo.released === "true" and pcInfo.returned !== "true", not moving to history database`])
                        //     await moveAndDeleteDocument(doc._id, 'historic-pcNotDelivered', false) // Move the document to the historic-pcNotDelivered collection instead
                        //     report.pcNotDeliveredHistoryCount += 1
                        // } else {
                            await moveAndDeleteDocument(doc._id, 'historic', false)
                            report.historyCount += 1
                        // }
                    } catch (error) {
                        logger('error', [loggerPrefix, `Error moving document with _id ${doc._id} to history database`, error])
                    }
                } else {
                    logger('info', [loggerPrefix, `Document with _id ${doc._id} has not returned the pc or have rates with status "Ikke Fakturert", not moving to history database`])
                }
            }
        }
    }

    logger('info', [loggerPrefix, 'Starting to update student information'])
    const documents = await getDocuments({}, 'regular')
    if(documents.result.length === 0) { return report } // If no documents are found, we can return the report
    report.totalNumberOfDocuments = documents.result.length
    for (const doc of documents.result) {
        const updateData = {}
        const fnr = doc.elevInfo.fnr
        let studentGotElevforhold = true
        const fintData = await student(fnr, false, false)
        if (fintData.status === 404 && fintData.message === 'Personen er ikke en student' && fintData.status !== 200) {
            // If the student is not found. Try to move the document to the history database. 
            try {
                await moveToHistoryDatabase(doc, updateData)
                report.newStudentsNotFoundInFINTCount += 1
            } catch (error) {
                logger('error', [loggerPrefix, `Error handling document with _id ${doc._id}`, error])
                continue
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
            let fintElevForhold
            if (Array.isArray(fintData.elevforhold)) {
                // Find all the active elevforhold
                const activeElevforhold = fintData.elevforhold.filter(forhold => forhold.aktiv === true)
                // If there are multiple active elevforhold, the student might be attending muliple schools. E.g privatist and regular student, or a VO student attending several classes at different schools.
                // For most students this wont matter, but if the student is a privatist or attending the fagskole (skole number 70036) we should not update the document with this elevforhold.
                // We should instead use the first elevforhold that is not a privatist or fagskole elevforhold.
                if (activeElevforhold.length > 1) {
                    fintElevForhold = activeElevforhold.find(forhold => forhold.kategori.navn.toLowerCase() !== 'privatist' && forhold.skole.skolenummer !== '70036')
                }
                // If there is only one active elevforhold, we can use that one
                if (!fintElevForhold) {
                    fintElevForhold = activeElevforhold[0]
                }
            }
            // Replace skole, klasse, trinn if fintElevForhold is found and if it is not a match with the document.elevInfo.skole, document.skoleOrgNr, document.elevInfo.klasse, document.elevInfo.trinn
            // If no active elevforhold is found, the student is no longer a student and we can move the document to the history database if the notFoundInFINT field is more than 5 days old.
            // We also exlude privatist students and students from skole 70036 (Privatister og elever ved fagskolen)
            if(fintElevForhold !== undefined && fintElevForhold.kategori.navn.toLowerCase() !== 'privatist' && fintElevForhold.skole.skolenummer !== '70036') {
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
                // If no active elevforhold is found, the student is no longer a student and we can move the document to the history database if the notFoundInFINT field is more than 10 days old.
                logger('info', [loggerPrefix, `No active elevforhold found for document ${doc._id}, but elev was found in FINT`])
                try {
                    await moveToHistoryDatabase(doc, updateData)
                    report.studentsWithoutActiveElevforholdCount += 1
                    studentGotElevforhold = false
                    studentsWithoutActiveElevforhold.push(doc._id)
                } catch (error) {
                    logger('error', [loggerPrefix, `Error handling document with _id ${doc._id}`, error])
                    continue
                }
            }
            // If there are any updates, we can update the document as long as the studentGotElevforhold is true otherwise the document have already been handled in the moveToHistoryDatabase function
            if (Object.keys(updateData).length > 0 && fintData.status !== 404 && studentGotElevforhold === true) {
                updatedDocuments.push(doc._id)
                report.updateCount += 1
                updateData["notFoundInFINT"] = {} // Reset notFoundInFINT field
                updateData["lastFINTSyncTimeStamp"] = new Date() // Update the lastFINTSyncTimeStamp to the current date
                logger('info', [loggerPrefix, `Updating document ${doc._id} with new data`])
                await updateDocument(doc._id, updateData, 'regular')
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
                                text: `**${report.totalNumberOfDocuments}** dokument(er) ble funnet og prosessert`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
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
                                text: `**${report.studentsWithoutActiveElevforholdCount}** elever har ikke et aktivt elevforhold`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            // So many that the teams request fails, check logs instead :P
                            // {
                            //     type: 'FactSet',
                            //     facts: report.studentsWithoutActiveElevforhold.map(id => ({ title: 'Document ID', value: id }))
                            // },
                            {
                                type: 'TextBlock',
                                text: `**${report.newStudentsNotFoundInFINTCount}** nye student(er) ble ikke funnet i FINT`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'TextBlock',
                                text: `**${report.pcNotDeliveredHistoryCountOrRatesNotPaiedCount}** dokument(er) ble ikke flyttet til historikk-databasen fordi pc ikke er levert tilbake eller har utestående fakturaer`,
                                wrap: true,
                                weight: 'Bolder',
                                size: 'Medium'
                            },
                            {
                                type: 'FactSet',
                                facts: report.studentsWithoutActiveElevforhold.map(id => ({ title: 'Document ID', value: id }))
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