const { logger } = require("@vtfk/logger")
const { student } = require("./queryFINT")
const { person } = require("./queryFREG")
const { getMongoClient } = require('../auth/mongoClient.js')
const { mongoDB } = require("../../../config")
const { getSchoolyear } = require("../helpers/getSchoolyear")



const fillDocument = (formInfo, elevData, ansvarligData, error) => {
    const document = {
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
        signedSkjemaInfo: {
            refId: 'Ukjent',
            acosName: 'Ukjent',
            kontraktType: 'Ukjent',
            archiveDocumentNumber: 'Ukjent',
            createdTimeStamp: 'Ukjent',
        },
        signedBy: {
            navn: 'Ukjent',
            fnr: 'Ukjent',
        },
        elevInfo: undefined,
        ansvarligInfo: undefined,
        fakturaInfo: {
            // Inneholder infomasjon om faktura, hvor mange rater du skal betale og har betalt. Hvor mye du skal betale per rate. 
        },
        error: error || [],
    }
    if(elevData?.status !== 404) {
        document.elevInfo = {
            navn: elevData.navn || 'Ukjent',
            upn: elevData.upn || 'Ukjent',
            fnr: formInfo.parseXml.result.ArchiveData.FnrElev || 'Ukjent',
            elevnr: elevData.elevnummer || 'Ukjent',
            skole: elevData.elevforhold[0].basisgruppemedlemskap[0].skole.navn || 'Ukjent',
            klasse: elevData.elevforhold[0].basisgruppemedlemskap[0].navn || 'Ukjent',
            trinn: elevData.elevforhold[0].basisgruppemedlemskap[0].trinn || 'Ukjent',
        }
    }
    if(ansvarligData !== undefined) {
        document.ansvarligInfo = {
            navn: ansvarligData.fulltnavn || 'Ukjent',
            fnr: formInfo.parseXml.result.ArchiveData.FnrForesatt || 'Ukjent',
        }
    }
    return document
}

const updateFormInfo = async (formInfo) => {
    /*
    * Søker etter skjema i MongoDB usignert og oppdaterer det.
    * Fra formInfo kommer en unik UUID som du kan søker etter i kontrakter collection. Det usignerte og det signerte skjemaet skal ha den samme unike UUID'en.
    */      
    const logPrefix = 'updateFormInfo'

    // Valider formInfo
    if(!formInfo){
        logger('error', [logPrefix, 'Mangler formInfo'])
        return {status: 400, error: 'Mangler formInfo'}
    }
    if(!formInfo.parseXml.result.ArchiveData.refId){
        logger('error', [logPrefix, 'Mangler refId', `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler refId', acosName: formInfo.acosName}
    }
    if(!formInfo.parseXml.result.ArchiveData.acosName){
        logger('error', [logPrefix, 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
        return {status: 400, error: 'Mangler acosName', refId: formInfo.refId}
    }
    if(!formInfo.parseXml.result.ArchiveData.uuid) {
        logger('error', [logPrefix, 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(!formInfo.archive.result.DocumentNumber) {
        logger('error', [logPrefix, 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(!formInfo.parseXml.result.ArchiveData.FnrForesatt && !formInfo.parseXml.result.ArchiveData.FnrForesatt.length !== 11) {
        logger('error', [logPrefix, 'Mangler/Ugyldig FnrForesatt', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler/Ugyldig FnrForesatt', refId: formInfo.refId, acosName: formInfo.acosName}
    }


    let ansvarligData
    if(formInfo.parseXml.result.ArchiveData.FnrForesatt) {
        // Hent mer info om ansvarlig
        logger('info', [logPrefix, 'Henter data om ansvarlig', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        ansvarligData = await person(formInfo.parseXml.result.ArchiveData.FnrForesatt)
    }

    const mongoClient = await getMongoClient()
    const result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}${getSchoolyear()}`).updateOne({ 'uuid': formInfo.parseXml.result.ArchiveData.uuid }, { $set: 
        { 
            'isSigned': "true",
            'signedSkjemaInfo.refId': formInfo.refId,
            'signedSkjemaInfo.acosName': formInfo.acosName,
            'signedSkjemaInfo.kontraktType': formInfo.parseXml.result.ArchiveData.typeKontrakt || 'Ukjent',
            'signedSkjemaInfo.archiveDocumentNumber': formInfo.archive.result.DocumentNumber,
            'signedSkjemaInfo.createdTimeStamp': formInfo.createdTimeStamp || 'Ukjent',
            'signedBy.navn': ansvarligData.fulltnavn || 'Ukjent',
            'signedBy.fnr': formInfo.parseXml.result.ArchiveData.FnrForesatt,
        }
    })

    if(result.acknowledged !== true) {
        logger('error', [logPrefix, 'Error ved oppdatering av dokument', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
        return {status: 500, error: 'Error ved oppdatering av dokument', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid}
    } else {
        if(result.modifiedCount === 0 || result.matchedCount === 0) {
            logger('info', [logPrefix, 'Fant ikke dokument å oppdatere', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
            return {status: 404, error: 'Fant ikke dokument å oppdatere', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid}
        } else {
            logger('info', [logPrefix, 'Dokument oppdatert', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
            return {status: 200, message: 'Dokument oppdatert', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid}
        }
    }
}

const postFormInfo = async (formInfo) => {
    /*
    *   Poster skjema til MongoDB usnignert.
    *   Unike nøkler som skal være søkbare, elevFnr og foreldreFnr (om elev er under 18).
    *   Poster skjema med isError === 'true' til MongoDB for å ha kontroll over de som feiler uansett feil.
    */
    const logPrefix = 'postFormInfo'

    // Valider formInfo
    if(!formInfo){
        logger('error', ['updateFormInfo', 'Mangler formInfo'])
        return {status: 400, error: 'Mangler formInfo'}
    }
    if(!formInfo.parseXml.result.ArchiveData.refId){
        logger('error', ['updateFormInfo', 'Mangler refId', `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler refId', acosName: formInfo.acosName}
    }
    if(!formInfo.parseXml.result.ArchiveData.acosName){
        logger('error', ['updateFormInfo', 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
        return {status: 400, error: 'Mangler acosName', refId: formInfo.refId}
    }
    if(!formInfo.parseXml.result.ArchiveData.uuid) {
        logger('error', ['updateFormInfo', 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(!formInfo.archive.result.DocumentNumber) {
        logger('error', ['updateFormInfo', 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(!formInfo.parseXml.result.ArchiveData.FnrElev && !formInfo.parseXml.result.ArchiveData.FnrElev.length !== 11) {
        logger('error', ['updateFormInfo', 'Mangler/Ugyldig FnrElev', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler/Ugyldig FnrElev', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(!formInfo.parseXml.result.ArchiveData.FnrForesatt && !formInfo.parseXml.result.ArchiveData.FnrForesatt.length !== 11) {
        logger('error', ['updateFormInfo', 'Mangler/Ugyldig FnrForesatt', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler/Ugyldig FnrForesatt', refId: formInfo.refId, acosName: formInfo.acosName}
    }

    let elevData
    let ansvarligData
    let error = []
    if(formInfo.parseXml.result.ArchiveData.FnrElev) {
        // Hent mer info om eleven
        elevData = await student(formInfo.parseXml.result.ArchiveData.FnrElev)
        logger('info', [logPrefix, 'Henter data om elev', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        if(elevData.status === 404) {
            logger('info', [logPrefix, 'Elev ikke funnet i FINT, sjekker FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            elevData = await person(formInfo.parseXml.result.ArchiveData.FnrElev)
            // Eleven er ikke funnet
            if(elevData === undefined) {
                logger('info', [logPrefix, 'Elev ikke funnet i FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
                error.push({error: 'Elev ikke funnet', fnr: formInfo.parseXml.result.ArchiveData.FnrElev})
            } else {
                logger('info', [logPrefix, 'Elev ikke funnet i FINT, men vi fant data i FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
                error.push({error: 'Elev ikke funnet i FINT, men vi fant data i FREG', fnr: formInfo.parseXml.result.ArchiveData.FnrElev})
            }
        }
    }

    if(formInfo.parseXml.result.ArchiveData.FnrForesatt) {
        // Hent mer info om ansvarlig
        logger('info', [logPrefix, 'Henter data om ansvarlig', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        ansvarligData = await person(formInfo.parseXml.result.ArchiveData.FnrForesatt)
    }
    if(ansvarligData === undefined) {
        // Ansvarlig er ikke funnet
        logger('info', [logPrefix, 'Ansvarlig ikke funnet', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        error.push({error: 'Ansvarlig ikke funnet', fnr: formInfo.parseXml.result.ArchiveData.FnrForesatt})
    }

    const document = fillDocument(formInfo, elevData, ansvarligData, error)
    const mongoClient = await getMongoClient()
    // Update the database
    try {
        let result
        if(document.isError === 'true'){
            logger('info', [logPrefix, 'isError === true, poster dokument til error-collection', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            const errorCollection = `${mongoDB.errorCollection}${getSchoolyear()}`
            result = await mongoClient.db(mongoDB.dbName).collection(errorCollection).insertOne(document)
        } else {
            logger('info', [logPrefix, 'isError === false, poster dokument til kontrakter-collection', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            const contractsCollection = `${mongoDB.contractsCollection}${getSchoolyear()}`
            result = await mongoClient.db(mongoDB.dbName).collection(contractsCollection).insertOne(document)
        }
        return document
    } catch (error) {
        logger('error', [logPrefix, 'Error poster til db', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, error])
        return {status: 500, error: 'Error poster til db', refId: formInfo.refId, acosName: formInfo.acosName}
    }
}

module.exports = {
    postFormInfo,
    updateFormInfo,
}