const { logger } = require('@vtfk/logger')
const { student, schoolInfo } = require('../lib/jobs/queryFINT.js')
const { person } = require('../lib/jobs/queryFREG.js')
const { lookupKRR } = require('../lib/jobs/queryKRR.js')

const validateStudentInfo = async (ssn, onlyAnsvarlig) => {
    let studentData
    let personData
    let schoolInfoData
    const logPrefix = 'validateStudentInfo'

    // Validate SSN
    if(ssn.length !== 11 || isNaN(ssn)) {
        logger('error', [logPrefix, 'Invalid SSN'])
        return {
            isError: true,
            isNonFixAbleError: true,
            error: 'Invalid SSN'
        }

    }

    try {
        studentData = await student(ssn)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching student data', error])
        return {
            isError: true,
            isNonFixAbleError: false,
            error: 'Error fetching student data'
        }
    }
    
    try {
        personData = await person(ssn)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching person data', error])
        return {
            isError: true,
            isNonFixAbleError: false,
            error: 'Error fetching person data'
        }
    }
    try {
        schoolInfoData = await schoolInfo(await studentData.elevforhold[0].skole.organisasjonsId)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching school info', error])
        return {
            isError: true,
            isNonFixAbleError: false,
            error: 'Error fetching school info'
        }
        
    } 

    const subjectData = {
        student: studentData,
        person: personData
    }

    const dataToReturn = {
        isUnder18: undefined, // True/false
        isStudent: undefined, // True/false
        gotAnsvarlig: undefined, // True/false
        uuid: undefined, // String
        gotSchoolName: schoolInfoData.navn === null ? false : true, // True/false
        gotSchoolEpost: schoolInfoData.kontaktEpostadresse === null ? false : true, // True/false
        gotSchoolTelefon: schoolInfoData.kontaktTelefonnummer === null ? false : true, // True/false
        gotSchoolAdresse: schoolInfoData.postadresse?.adresselinje === null ? false : true, // True/false
        gotSchoolOrgNr: schoolInfoData.organisasjonsnummer === null ? false : true, // True/false
        schoolInfo: {
            navn: schoolInfoData.navn || null, // String
            epost: schoolInfoData.kontaktEpostadresse || null, // String
            telefon: schoolInfoData.kontaktTelefonnummer || null, // String
            orgnr: schoolInfoData.organisasjonsnummer || null, // String
            adresse: {
                postnummer: schoolInfoData.postadresse?.postnummer || null, // String
                poststed: schoolInfoData.postadresse?.poststed || null, // String
                adresse: schoolInfoData.postadresse?.adresselinje || null  // String
            }
        }, // Object
        ansvarlig: [], // Array
        ansvarligSomIkkeKanVarsles: [], // Array
        adressblock: undefined, // True/false
        isError: false, // True/false
        isNonFixAbleError: false, // True/false
        error: '' // String
    }

    // Check if student is registered in FINT, if not, check if any person data is found. 
    logger('info', [logPrefix, 'Sjekker om studenten er registrert i FINT'])
    if(subjectData.student.message === 'Not a student') {
        logger('info', [logPrefix, 'Fant ikke student i FINT, sjekker om vi finner noe persondata'])
        if(subjectData.person.foedselsEllerDNummer === null) {
            logger('info', [logPrefix, 'Fant ikke persondata, kan ikke prosessere'])
            dataToReturn.isNonFixAbleError = true
            dataToReturn.error = 'No data found, cant process.'
        } else {
            logger('info', [logPrefix, 'Fant ikke student i FINT, men fant persondata'])
        }
    } else {
        logger('info', [logPrefix, 'Fant student i FINT'])
        dataToReturn.isStudent = true
    }

    // Check if student is under 18
    if(subjectData.person.alder < 18) {
        logger('info', [logPrefix, 'Student er under 18'])
        dataToReturn.isUnder18 = true
        // If student is under 18 we also need to check if the student has foreldreansvar
        if(subjectData.person.foreldreansvar) {
            logger('info', [logPrefix, 'Student har foreldre/ansvarlig'])
            dataToReturn.gotAnsvarlig = true
            // If student has foreldre/ansvarlig we need to get additional data
            if(subjectData.person.foreldreansvar.length > 1 && subjectData.person.foreldreansvar[0].ansvar === 'felles') {
                for(let i = 0; i < subjectData.person.foreldreansvar.length; i++) {
                    const foreldreansvarlig = subjectData.person.foreldreansvar[i]
                    const foreldreansvarligData = await person(foreldreansvarlig.ansvarlig)
                    dataToReturn.ansvarlig.push(foreldreansvarligData)
                }
            } else {
                // If student has only one foreldre/ansvarlig we need to get additional data.
                const foreldreansvarlig = subjectData.person.foreldreansvar[0]
                const foreldreansvarligData = await person(foreldreansvarlig.ansvarlig)
                dataToReturn.ansvarlig.push(foreldreansvarligData)
            }
            // Check if parent/guardian can be contacted digitally
            logger('info', [logPrefix, 'Sjekker om foreldre/ansvarlig kan varsles digitalt'])
            for (const ansvarlig of subjectData.person.foreldreansvar) {
                try {
                    const krrData = await lookupKRR([ansvarlig.ansvarlig])
                    if(krrData.personer[0].varslingsstatus === 'KAN_IKKE_VARSLES') {
                        dataToReturn.ansvarligSomIkkeKanVarsles.push(dataToReturn.ansvarlig.filter((item) => item.foedselsEllerDNummer === ansvarlig.ansvarlig))
                        logger('info', [logPrefix, 'Foreldre/ansvarlig kan ikke varsles digitalt, ansvarlig er fjernet fra listen over ansvarlige'])
                        // Remove the parent/guardian from the list of parents/guardians that can be contacted digitally
                        dataToReturn.ansvarlig = dataToReturn.ansvarlig.filter((item) => item.foedselsEllerDNummer !== ansvarlig.ansvarlig)
                    }
                } catch (error) {
                    logger('error', [logPrefix, 'Error fetching KRR data for foreldre/ansvarlig', error])
                    dataToReturn.isError = true
                    dataToReturn.error = 'Error fetching KRR data for foreldre/ansvarlig'
                }
            }
            if(dataToReturn.ansvarlig.length === 0) {
                logger('info', [logPrefix, 'Fant ingen foreldre/ansvarlig som kan varsles digitalt'])
                dataToReturn.isNonFixAbleError = true
                dataToReturn.gotAnsvarlig = false
                dataToReturn.error = 'No foreldre/ansvarlig that can be contacted digitally'
            }
            if(dataToReturn.ansvarligSomIkkeKanVarsles.length > 0) {
                logger('info', [logPrefix, `Fant: ${dataToReturn.ansvarligSomIkkeKanVarsles.length} foreldre/ansvarlig som ikke kan varsles digitalt`])
                dataToReturn.gotAnsvarlig = true
                dataToReturn.isNonFixAbleError = true
            }
        } else {
            dataToReturn.ansvarlig = subjectData.person.foreldreansvar
            logger('info', [logPrefix, 'Student har ikke foreldre/ansvarlig'])
            dataToReturn.isNonFixAbleError = true
            dataToReturn.error = 'No foreldre/ansvarlig found'
        }
    } else {
        logger('info', [logPrefix, 'Student er 18 eller eldre'])
        // Check if student can be contacted digitally
        const krrData = await lookupKRR([ssn])
        if(krrData[0].varslingsstatus === 'KAN_IKKE_VARSLES') {
            dataToReturn.isNonFixAbleError = true
            logger('info', [logPrefix, 'Student kan ikke varsles digitalt'])
            dataToReturn.error = 'Student kan ikke varsles digitalt'
        }
        dataToReturn.isUnder18 = false
        dataToReturn.ansvarlig = subjectData.person.foreldreansvar
    }
    
    // Only run this check if theres no previous errors
    if(dataToReturn.isNonFixAbleError === undefined) {
        // Check if student has adressblock
        if(subjectData.person?.bostedsadresse?.adressegradering !== 'ugradert') {
            // Should we handle this person??
            dataToReturn.adressblock = true
        } else {
            dataToReturn.adressblock = false
        }
    }
    // If we need to handle the person manually, we should return an error
    if(dataToReturn.adressblock === true) {
        dataToReturn.isNonFixAbleError = true
        dataToReturn.error = 'Must handle manually'
    }

    // Generate a unique UUID for the current form submission so we can use this later to match with the signed document
    dataToReturn.uuid = crypto.randomUUID()

    if(onlyAnsvarlig === 'true') {
        return dataToReturn.ansvarlig
    } else {
        return dataToReturn
    }
}

module.exports = {
    validateStudentInfo
}