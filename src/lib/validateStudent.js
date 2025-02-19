const { logger } = require('@vtfk/logger')
const { student, schoolInfo } = require('../lib/jobs/queryFINT.js')
const { person } = require('../lib/jobs/queryFREG.js')

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
            error: 'Invalid SSN'
        }

    }

    try {
        studentData = await student(ssn)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching student data', error])
        return {
            isError: true,
            error: 'Error fetching student data'
        }
    }
    
    try {
        personData = await person(ssn)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching person data', error])
        return {
            isError: true,
            error: 'Error fetching person data'
        }
    }
    try {
        schoolInfoData = await schoolInfo(await studentData.elevforhold[0].skole.organisasjonsId)
        console.log(schoolInfoData)
    } catch (error) {
        logger('error', [logPrefix, 'Error fetching school info', error])
        return {
            isError: true,
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
        gotSchoolName: schoolInfoData.navn === null ? false : true, // True/false
        gotSchoolEpost: schoolInfoData.kontaktEpostadresse === null ? false : true, // True/false
        gotScgoolTelefon: schoolInfoData.kontaktTelefonnummer === null ? false : true, // True/false
        gotSchoolAdresse: schoolInfoData.postadresse?.adresselinje === null ? false : true, // True/false
        schoolInfo: {
            navn: schoolInfoData.navn || null, // String
            epost: schoolInfoData.kontaktEpostadresse || null, // String
            telefon: schoolInfoData.kontaktTelefonnummer || null, // String
            adresse: {
                postnummer: schoolInfoData.postadresse?.postnummer || null, // String
                poststed: schoolInfoData.postadresse?.poststed || null, // String
                adresse: schoolInfoData.postadresse?.adresselinje || null  // String
            }
        }, // Object
        ansvarlig: [], // Array 
        adressblock: undefined, // True/false
        isError: false, // True/false
        error: '' // String
    }

    // Check if student is registered in FINT, if not, check if any person data is found. 
    logger('info', [logPrefix, 'Checking if student is registered in FINT'])
    if(subjectData.student.message === 'Not a student') {
        logger('info', [logPrefix, 'Student not found in FINT, checking if any person data is found'])
        if(subjectData.person.foedselsEllerDNummer === null) {
            logger('info', [logPrefix, 'No person data found'])
            dataToReturn.isError = true
            dataToReturn.error = 'No data found, cant process.'
        } else {
            logger('info', [logPrefix, 'Student not found in FINT, but person data found'])
        }
    } else {
        logger('info', [logPrefix, 'Student found in FINT'])
        dataToReturn.isStudent = true
    }

    // Check if student is under 18
    if(subjectData.person.alder < 18) {
        logger('info', [logPrefix, 'Student is under 18'])
        dataToReturn.isUnder18 = true
        // If student is under 18 we also need to check if the student has foreldreansvar
        if(subjectData.person.foreldreansvar) {
            logger('info', [logPrefix, 'Student has foreldre/ansvarlig'])
            dataToReturn.gotAnsvarlig = true
            // If student has foreldre/ansvarlig we need to get additional data
            if(subjectData.person.foreldreansvar.length > 1 && subjectData.person.foreldreansvar[0].ansvar === 'felles') {
                for(let i = 0; i < subjectData.person.foreldreansvar.length; i++) {
                    const foreldreansvarlig = subjectData.person.foreldreansvar[i]
                    const foreldreansvarligData = await person(foreldreansvarlig.ansvarlig)

                    // subjectData.person.foreldreansvar[i] = foreldreansvarligData
                    dataToReturn.ansvarlig.push(foreldreansvarligData)
                }
            } else {
                // If student has only one foreldre/ansvarlig we need to get additional data.
                const foreldreansvarlig = subjectData.person.foreldreansvar[0]
                const foreldreansvarligData = await person(foreldreansvarlig.ansvarlig)

                // subjectData.person.foreldreansvar[0] = foreldreansvarligData
                dataToReturn.ansvarlig.push(foreldreansvarligData)
            }
            // dataToReturn.ansvarlig = subjectData.person.foreldreansvar
        } else {
            dataToReturn.ansvarlig = subjectData.person.foreldreansvar
            logger('info', [logPrefix, 'Student does not have foreldre/ansvarlig'])
            dataToReturn.isError = true
            dataToReturn.error = 'No foreldre/ansvarlig found'
        }
    } else {
        logger('info', [logPrefix, 'Student is 18 or older'])
        dataToReturn.isUnder18 = false
        dataToReturn.ansvarlig = subjectData.person.foreldreansvar
    }
    
    // Only run this check if theres no previous errors
    if(dataToReturn.isError === undefined) {
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
        dataToReturn.isError = true
        dataToReturn.error = 'Must handle manually'
    }

    if(onlyAnsvarlig === 'true') {
        return dataToReturn.ansvarlig
    } else {
        return dataToReturn
    }
}

module.exports = {
    validateStudentInfo
}