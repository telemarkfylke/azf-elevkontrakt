const { logger } = require("@vtfk/logger")
const { student } = require("./queryFINT")
const { person } = require("./queryFREG")
const { getMongoClient } = require('../auth/mongoClient.js')
const { mongoDB } = require("../../../config")
const { getSchoolyear } = require("../helpers/getSchoolyear")
const { fillDocument } = require("../documentSchema.js")
const { ObjectId } = require("mongodb")

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
    if(!formInfo.refId){
        logger('error', [logPrefix, 'Mangler refId', `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler refId', acosName: formInfo.acosName}
    }
    if(!formInfo.acosName){
        logger('error', [logPrefix, 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
        return {status: 400, error: 'Mangler acosName', refId: formInfo.refId}
    }
    if(!formInfo.parseXml.result.ArchiveData.uuid) {
        logger('error', [logPrefix, 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return {status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName}
    }
    if(formInfo?.archive) {
        if(!formInfo.archive.result.DocumentNumber) {
            logger('error', [logPrefix, 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            return {status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName}
        }
    }

    let ansvarligData
    if(formInfo.parseXml.result.ArchiveData.FnrForesatt) {
        // Hent mer info om ansvarlig
        logger('info', [logPrefix, 'Henter data om ansvarlig', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        ansvarligData = await person(formInfo.parseXml.result.ArchiveData.FnrForesatt)
    }

    const mongoClient = await getMongoClient()
    const result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ 'uuid': formInfo.parseXml.result.ArchiveData.uuid }, { $set: 
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

const postFormInfo = async (formInfo, isMock) => {
    /*
    *   Poster skjema til MongoDB usnignert.
    *   Unike nøkler som skal være søkbare, elevFnr og foreldreFnr (om elev er under 18).
    *   Poster skjema med isError === 'true' til MongoDB for å ha kontroll over de som feiler uansett feil.
    */
    const logPrefix = 'postFormInfo'
    // Hvis isMock === true, skip validering, vi ønsker å poste mock data til db direkte
    if(isMock !== true) {   
    // Valider formInfo
        if(!formInfo){
            logger('error', ['updateFormInfo', 'Mangler formInfo'])
            return {status: 400, error: 'Mangler formInfo'}
        }
        if(!formInfo.refId){
            logger('error', ['updateFormInfo', 'Mangler refId', `acosName: ${formInfo.acosName}`])
            return {status: 400, error: 'Mangler refId', acosName: formInfo.acosName}
        }
        if(!formInfo.acosName){
            logger('error', ['updateFormInfo', 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
            return {status: 400, error: 'Mangler acosName', refId: formInfo.refId}
        }
        if(!formInfo.parseXml.result.ArchiveData.uuid && (!formInfo.parseXml.result.ArchiveData.isError === "true" || !formInfo.parseXml.result.ArchiveData.isNonFixAbleError === "true")) {
            logger('error', ['updateFormInfo', 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            return {status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName}
        }
        if(formInfo?.archive) {
            if(!formInfo.archive.result.DocumentNumber) {
                logger('error', ['updateFormInfo', 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
                return {status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName}
            }
        }
        
    }

    let elevData
    let ansvarligData
    let document
    let error = []
    // Sett docmunet = formInfo om isMock === true. Infoform er mock data
    isMock === true ? document = formInfo : document = document
    // Hvis isMock === true, skip henting av elev og ansvarlig data, vi ønsker å poste mock data til db direkte
    if(isMock !== true) {
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
    
        document = fillDocument(formInfo, elevData, ansvarligData, error)
    }
  
    const mongoClient = await getMongoClient()


    let mongoDBCollection
    let mongoDBErrorCollection
    // Velger collection basert på om det er mock eller ikke
    if(isMock === true) {
        mongoDBCollection = `${mongoDB.contractsMockCollection}`
        mongoDBErrorCollection = `${mongoDB.errorMockCollection}`
    } else {
        mongoDBCollection = `${mongoDB.contractsCollection}`
        mongoDBErrorCollection = `${mongoDB.errorCollection}`
    }
    // Poster dokument til riktig collection
    try {
        let result
        if(document.isError === 'true' || document.isNonFixAbleError === 'true'){
            logger('info', [logPrefix, 'isError === true eller isNonFixAbleError === true, poster dokument til error-collection', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            const errorCollection = `${mongoDBErrorCollection}`
            result = await mongoClient.db(mongoDB.dbName).collection(errorCollection).insertOne(document)
        } else {
            logger('info', [logPrefix, 'isError === false, poster dokument til kontrakter-collection', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            const contractsCollection = `${mongoDBCollection}`
            result = await mongoClient.db(mongoDB.dbName).collection(contractsCollection).insertOne(document)
        }
        return document
    } catch (error) {
        logger('error', [logPrefix, 'Error poster til db', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, error])
        return {status: 500, error: 'Error poster til db', refId: formInfo.refId, acosName: formInfo.acosName}
    }
}

const getDocuments = async (query, isMock) => {
    const logPrefix = 'getDocuments'
    const mongoClient = await getMongoClient()

    let result
    if(isMock === true) {
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).find(query).toArray()
    } else {
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).find(query).toArray()
    }
    if(result.length === 0) {
        logger('info', [logPrefix, 'Fant ingen dokumenter'])
        return {status: 404, error: 'Fant ingen dokumenter'}
    } else {
        logger('info', [logPrefix, `Fant ${result.length} dokumenter`])
        return {status: 200, result}
    }
}

const updateContractPCStatus = async (contract, isMock) => {
    // Fields to update:
    // pcInfo.releasedBy: "innlogget bruker"
    // pcInfo.releasedDate: "timestamp"
    // pceInfo.released: "true" 

    // Find contract in collection using the provided ID
    // Update the fields
    // Return updated contract
    const logPrefix = 'updateContractPCStatus'
    const mongoClient = await getMongoClient()

    let pcUpdateObject = {}
    
    // Check if contractID is provided
    if(!contract.contractID) {
        logger('error', [logPrefix, 'Mangler contractID'])
        return {status: 400, error: 'Mangler contractID'}
    }

    // Check if releasePC or returnPC is provided
    if(!contract.releasePC && !contract.returnPC) {
        logger('error', [logPrefix, 'Mangler releasePC eller returnPC'])
        return {status: 400, error: 'Mangler releasePC eller returnPC'}
    }

    // If releasePC or returnPC is provided, provide the correct info
    if(contract.releasePC === true) {
        logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, releasePC: ${contract.releasePC}`])
        const releasePCInfo = {
            'pcInfo.releasedBy': "innlogget bruker",
            'pcInfo.releasedDate': new Date(),
            'pcInfo.released': "true"
        }
        pcUpdateObject = releasePCInfo
    } else if (contract.returnPC === true) {
        logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, returnPC: ${contract.returnPC}`])
        const returnPCInfo = {
            'pcInfo.returnedBy': "innlogget bruker",
            'pcInfo.returnedDate': new Date(),
            'pcInfo.returned': "true"
        }
        pcUpdateObject = returnPCInfo
    } else {
        logger('error', [logPrefix, 'Mangler releasePC eller returnPC'])
        return {status: 400, error: 'Mangler releasePC eller returnPC'}
    }

    let result 
    if(isMock === true) {
        // Update contract in mock collection
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).updateOne({ '_id': new ObjectId(contract.contractID) }, { $set: pcUpdateObject })
    } else {
        // Update contract in collection
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ '_id': new ObjectId(contract.contractID) }, { $set: pcUpdateObject })
    }

    return result
}

module.exports = {
    postFormInfo,
    updateFormInfo,
    getDocuments,
    updateContractPCStatus
}