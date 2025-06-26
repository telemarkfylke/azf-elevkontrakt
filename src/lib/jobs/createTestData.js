const { fillDocument } = require("../documentSchema.js")

const schools = [
    {
        orgNr: "974568152",
        officeLocation: 'Skogmo videregående skole',
    },
    {
        orgNr: "974568039",
        officeLocation: 'Skien videregående skole',
    },
    {
        orgNr: "974568098", // Skolen sitt org nummer
        officeLocation: 'Bamble videregående skole', // Officelocation som kommer og matcher fra AD (graph)
    },
    {
        orgNr: "974568020",
        officeLocation: 'Porsgrunn videregående skole',
    },
]

/*
    uuid: formInfo.parseXml.result.ArchiveData.uuid,
    isSigned: "false",
    isFakturaSent: "false",
    isError: formInfo.parseXml.result.ArchiveData.isError || 'Ukjent',
    isUnder18: formInfo.parseXml.result.ArchiveData.isUnder18 || 'Ukjent',
    gotAnsvarlig: formInfo.parseXml.result.ArchiveData.FnrForesatt.length > 0 ? "true" : "false",
    isStudent: formInfo.parseXml.result.ArchiveData.SkoleOrgNr.length > 0 ? "true" : "false",
    skoleOrgNr: formInfo.parseXml.result.ArchiveData.SkoleOrgNr || 'Ukjent',
    unSignedskjemaInfo: {
        refId: formInfo.refId,
        acosName: formInfo.acosName ,
        kontraktType: formInfo.parseXml.result.ArchiveData.typeKontrakt || 'Ukjent',
        archiveDocumentNumber: formInfo.archive.result.DocumentNumber ,
        createdTimeStamp: formInfo.createdTimeStamp || 'Ukjent',
    },
*/
const generateFormInfoUnsigned = (randomIndex, elevFnr, ansvarligFnr, isUnder18) => {
    const formInfo = {
        refId: Math.floor(1000000 + Math.random() * 9000000).toString(), // Random 7-digit number, to simulate refId
        acosName: 'Elevavtale usignert',
        createdTimeStamp: new Date(new Date().setDate(new Date().getDate() + Math.random(1)*9)), // Random date today +1 to 9 days
        archive: {
            result: {
                DocumentNumber: `${new Date().getFullYear().toString().split(0)[1]}/${Math.floor(10000 + Math.random() * 90000)}-${Math.floor(10 + Math.random() * 90)}` // Random archive number to simulate archive number
            }
        },
        parseXml: {
            result: {
                ArchiveData: {
                    uuid: crypto.randomUUID(),
                    isError: 'false',
                    isUnder18: isUnder18,
                    FnrForesatt: isUnder18 === "true" ? ansvarligFnr : '',
                    SkoleOrgNr: schools[randomIndex].orgNr,
                    typeKontrakt: 'leieavtale',
                    FnrElev: elevFnr
                }
            }
        }
    }
    return formInfo
}


/*
    { 
        'isSigned': "true", ✅
        'signedSkjemaInfo.refId': formInfo.refId,✅
        'signedSkjemaInfo.acosName': formInfo.acosName, ✅
        'signedSkjemaInfo.kontraktType': formInfo.parseXml.result.ArchiveData.typeKontrakt || 'Ukjent', ✅
        'signedSkjemaInfo.archiveDocumentNumber': formInfo.archive.result.DocumentNumber, ✅
        'signedSkjemaInfo.createdTimeStamp': formInfo.createdTimeStamp || 'Ukjent', ✅
        'signedBy.navn': ansvarligData.fulltnavn || 'Ukjent', ✅
        'signedBy.fnr': formInfo.parseXml.result.ArchiveData.FnrForesatt, ✅
    }
*/
const generateFormInfoSigned = (unSignedForm) => {
    unSignedForm.isSigned = "true"
    unSignedForm.signedSkjemaInfo.acosName = 'Elevavtale signert'
    unSignedForm.signedSkjemaInfo.kontraktType = "leieavtale - signert"
    unSignedForm.signedSkjemaInfo.refId = Math.floor(1000000 + Math.random() * 9000000).toString()
    unSignedForm.signedSkjemaInfo.createdTimeStamp = new Date(new Date().setDate(new Date().getDate() + Math.random(1)*9)) // Random date today +1 to 9 days
    unSignedForm.signedSkjemaInfo.archiveDocumentNumber = `${new Date().getFullYear().toString().split(0)[1]}/${Math.floor(10000 + Math.random() * 90000)}-${Math.floor(10 + Math.random() * 90)}` // Random archive number to simulate archive number
    unSignedForm.signedBy.navn = unSignedForm.ansvarligInfo.navn
    unSignedForm.signedBy.fnr = unSignedForm.ansvarligInfo.fnr
    return unSignedForm
}

/*
        elevData.navn || 'Ukjent',
        elevData.fornavn || 'Ukjent',
        elevData.etternavn || 'Ukjent',
        elevData.upn || 'Ukjent',
        formInfo.parseXml.result.ArchiveData.FnrElev || 'Ukjent',
        elevData.elevnummer || 'Ukjent',
        elevData.elevforhold[0].basisgruppemedlemskap[0].skole.navn || 'Ukjent',
        elevData.elevforhold[0].basisgruppemedlemskap[0].navn || 'Ukjent',
        elevData.elevforhold[0].basisgruppemedlemskap[0].trinn || 'Ukjent',
*/

const generateElevData = (randomIndex, studentNumber, classNumber) => {
    const elevData = {
        navn: `Test Elev${studentNumber}`,
        fornavn: `Test`,
        etternavn: `Elev${studentNumber}`,
        upn: `elev${studentNumber}@testfylke.no`,
        elevnummer: Math.floor(10000000 + Math.random() * 90000000).toString(), // Random 8-digit number, to simulate elevnummer
        elevforhold: [
            {
                basisgruppemedlemskap: [
                    {
                        skole: {
                            navn: schools[randomIndex].officeLocation,
                        },
                        navn: `${classNumber}ABC`, // Random number between 1-3 to simulate trinn
                        trinn: `VG${classNumber}` // Random number between 1-3 to simulate trinn,
                    }
                ]
            }
        ]
    }
    return elevData
} 

/*
        ansvarligData.fulltnavn || 'Ukjent',
        formInfo.parseXml.result.ArchiveData.FnrForesatt || 'Ukjent',
*/
const generateAnsvarligData = (studentNumber, elevFnr, ansvarligFnr, isUnder18) => {
    const ansvarligData = {
        fulltnavn: isUnder18 === "true" ? `Test Ansvarlig${Math.floor(10000 + Math.random() * 90000)}` : `Test Ansvarlig${studentNumber}`,
        fnr: isUnder18 === "true" ? ansvarligFnr : elevFnr
    }
    return ansvarligData
}

const createTestDataUnSigned = () => {
    const randomIndex = Math.floor(Math.random() * schools.length) // Random index to get random school from schools array
    const studentNumber = Math.floor(10000 + Math.random() * 90000).toString() // Random 5-digit number, to simulate elevnummer
    const classNumber = Math.floor(1 + Math.random() * 3) // Random number between 1-3 to simulate trinn
    const elevFnr = Math.floor(10000000000 + Math.random() * 90000000000).toString() // Random 11-digit number, to simulate FnrElev
    const ansvarligFnr = Math.floor(10000000000 + Math.random() * 90000000000).toString() // Random 11-digit number, to simulate FnrForesatt
    const isUnder18 = (Math.random() < 0.7).toString() // Random true/false to simulate isUnder18



    const formInfo = generateFormInfoUnsigned(randomIndex, elevFnr, ansvarligFnr, isUnder18)
    const elevData = generateElevData(randomIndex, studentNumber, classNumber)
    const ansvarligData = generateAnsvarligData(studentNumber, elevFnr, ansvarligFnr, isUnder18)

    const unSignedForm = fillDocument(formInfo, elevData, ansvarligData)

    return unSignedForm
}

const createTestDataSigned = () => {
    const unSignedForm = createTestDataUnSigned()
    const formInfo = generateFormInfoSigned(unSignedForm)

    return formInfo
}

module.exports = {
    createTestDataUnSigned,
    createTestDataSigned
}