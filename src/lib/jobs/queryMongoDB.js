const { logger } = require("@vtfk/logger")
const { student } = require("./queryFINT")
const { person } = require("./queryFREG")
const { getMongoClient } = require('../auth/mongoClient.js')
const { mongoDB } = require("../../../config")
// const { getSchoolyear } = require("../helpers/getSchoolyear")
const { fillDocument, fillManualDocument } = require("../documentSchema.js")
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
    if(!formInfo.parseXml.result.ArchiveData.uuid || formInfo.parseXml.result.ArchiveData.uuid === '' || formInfo.parseXml.result.ArchiveData.uuid === undefined || formInfo.parseXml.result.ArchiveData.uuid === null || formInfo.parseXml.result.ArchiveData.uuid === 'null') {
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
        if(!formInfo.parseXml.result.ArchiveData.uuid || formInfo.parseXml.result.ArchiveData.uuid === '' || formInfo.parseXml.result.ArchiveData.uuid === undefined || formInfo.parseXml.result.ArchiveData.uuid === null || formInfo.parseXml.result.ArchiveData.uuid === 'null' && (!formInfo.parseXml.result.ArchiveData.isError === "true" || !formInfo.parseXml.result.ArchiveData.isNonFixAbleError === "true")) {
            logger('error', [logPrefix, 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
            return {status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName}
        }
        if(formInfo?.archive) {
            if(!formInfo.archive.result.DocumentNumber) {
                logger('error', [logPrefix, 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
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
    // pcInfo.releasedBy: "innlogget bruker - redigert av administrator"
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
            'pcInfo.releaseBy': "innlogget bruker - redigert av administrator",
            'pcInfo.releasedDate': new Date(),
            'pcInfo.released': "true"
        }
        pcUpdateObject = releasePCInfo
    } else if (contract.returnPC === true) {
        logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, returnPC: ${contract.returnPC}`])
        const returnPCInfo = {
            'pcInfo.returnedBy': "innlogget bruker - redigert av administrator",
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

const postManualContract = async (contract, archiveData, isMock) => {
    const logPrefix = 'postManualContract'
    const mongoClient = await getMongoClient()

    // Valider contract
    if(!contract) {
        logger('error', [logPrefix, 'Mangler contract'])
        return {status: 400, error: 'Mangler contract'}
    }
    if(!archiveData || !archiveData.DocumentNumber) {
        logger('error', [logPrefix, 'Mangler archiveData eller DocumentNumber'])
        return {status: 400, error: 'Mangler archiveData eller DocumentNumber'}
    }
    let elevData
    let ansvarligData

    if(isMock !== true) {
        if(contract.fnr) {
            // Hent mer info om eleven
            elevData = await student(contract.fnr)
            logger('info', [logPrefix, 'Henter data om elev, manuell kontrakt'])
            if(elevData.status === 404) {
                logger('info', [logPrefix, 'Elev ikke funnet i FINT, sjekker FREG'])
                elevData = await person(contract.fnr)
                // Eleven er ikke funnet
                if(elevData === undefined) {
                    logger('error', [logPrefix, 'Elev ikke funnet i FREG'])
                    throw new Error('Elev ikke funnet')
                } else {
                    logger('error', [logPrefix, 'Elev ikke funnet i FINT'])
                    throw new Error('Elev ikke funnet i FINT')
                }
            }
        }

        if(contract.foresattFnr !== '') {
            // Hent mer info om ansvarlig
            logger('info', [logPrefix, 'Henter data om ansvarlig'])
            ansvarligData = await person(contract.foresattFnr)
        } else {
            logger('info', [logPrefix, 'Ingen foresatt oppgitt for manuell kontrakt, ansvarlig er da eleven selv'])
            ansvarligData = await person(contract.fnr)
        }
        if(ansvarligData === undefined) {
            // Ansvarlig er ikke funnet
            logger('info', [logPrefix, 'Ansvarlig ikke funnet'])
            throw new Error('Ansvarlig ikke funnet')
        }
    }
    // Fyll ut dokumentet med data
    const document = fillManualDocument(contract, archiveData, elevData, ansvarligData)

    let result
    try {
        if(isMock === true) {
            result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).insertOne(document)
        } else {
            result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).insertOne(document)
        }
        if(result.acknowledged !== true) {
            logger('error', [logPrefix, 'Error ved oppretting av manuelt kontraktsdokument'])
            throw new Error('Error ved oppretting av manuelt kontraktsdokument')
        } else {
            logger('info', [logPrefix, 'Manuelt kontraktsdokument opprettet'])
            return {result: result, document: document}
        }
    } catch (error) {
        logger('error', [logPrefix, 'Error poster til db', error])
        throw new Error('Error poster til db', error)
    }

}

/**
 * Flytt et dokument til en annen collection og slett det fra den opprinnelige collection
 * @param {*} documentId | _id til dokumentet som skal slettes
 * @param {*} targetCollection | deleted | historic
 * @param {*} isMock | true | false
 * @returns 
 */

const moveAndDeleteDocument = async (documentId, targetCollection, isMock) => {
    const logPrefix = 'moveAndDeleteDocument'
    const mongoClient = await getMongoClient()

    // Valider documentId
    if(!documentId) {
        logger('error', [logPrefix, 'Mangler documentId'])
        return {status: 400, error: 'Mangler documentId'}
    }
    // Valider targetCollection
    if(!targetCollection) {
        logger('error', [logPrefix, 'Mangler targetCollection'])
        return {status: 400, error: 'Mangler targetCollection'}
    }

    const moveDocumentToTargetCollection = async (documentId, targetCollection, isMock) => {
        // Flytt dokumentet fra mock collection til deleted collection
        const docToMove = await mongoClient.db(mongoDB.dbName).collection(`${isMock ? mongoDB.contractsMockCollection : mongoDB.contractsCollection}`).findOne({ '_id': new ObjectId(documentId) })
        if(!docToMove) {
            logger('error', [logPrefix, 'Dokument ikke funnet for flytting'])
            return {status: 404, error: 'Dokument ikke funnet for flytting'}
        }
        // Sjekk om deleted collection finnes, hvis ikke, opprett den
        let collection = ''
        // const deletedCollection = isMock ? mongoDB.deletedMockCollection : mongoDB.deletedCollection

        if(targetCollection === 'deleted') {
            collection = isMock ? mongoDB.deletedMockCollection : mongoDB.deletedCollection
        } else if (targetCollection === 'historic') {
            collection = mongoDB.historicCollection
        }
        const collectionExists = await mongoClient.db(mongoDB.dbName).listCollections({ name: collection }).hasNext()
        if(!collectionExists) {
            logger('info', [logPrefix, `Oppretter target collection: ${collection}`])
            try {
                await mongoClient.db(mongoDB.dbName).createCollection(collection)
            } catch (error) {
                logger('error', [logPrefix, `Error ved oppretting av target collection: ${collection}`, error])
                return {status: 500, error: `Error ved oppretting av target collection: ${collection}`}
            }
        }
        // Flytt dokumentet til target collection
        logger('info', [logPrefix, `Flytter dokument med _id: ${documentId} til target collection: ${collection}`])
        const result = await mongoClient.db(mongoDB.dbName).collection(collection).insertOne(docToMove)
        if(result.acknowledged !== true) {
            logger('error', [logPrefix, `Error ved flytting av dokument til target collection: ${collection}`])
            return {status: 500, error: `Error ved flytting av dokument til target collection: ${collection}`}
        } else {
            logger('info', [logPrefix, `Dokument flyttet til target collection: ${collection}`])
            return {status: 200, message: `Dokument flyttet til target collection: ${collection}`}
        }
    }

    let result
    if(isMock === true) {
        // Flytt dokumentet til target collection
        const moveResult = await moveDocumentToTargetCollection(documentId, targetCollection, isMock)
        if(moveResult.status !== 200) {
            return moveResult
        } else {
            logger('info', [logPrefix, `Dokument flyttet til target collection: ${targetCollection}, fortsetter med sletting fra mock collection`])
            // Slett dokumentet i mock collection
            logger('info', [logPrefix, `Sletter dokument med _id: ${documentId} fra mock collection`])
            result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).deleteOne({ '_id': new ObjectId(documentId) })
        }
    } else {
        // Flytt dokumentet til target collection
        isMock = false
        const moveResult = await moveDocumentToTargetCollection(documentId, targetCollection, isMock)
        if(moveResult.status !== 200) {
            return moveResult
        } else {
            logger('info', [logPrefix, `Dokument flyttet til target collection: ${targetCollection}, fortsetter med sletting fra collection`])
            // Slett dokumentet i collection
            logger('info', [logPrefix, `Sletter dokument med _id: ${documentId} fra collection`])
            result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).deleteOne({ '_id': new ObjectId(documentId) })
        }
    }

    if(result.deletedCount === 0) {
        logger('error', [logPrefix, 'Dokument ikke funnet'])
        return {status: 404, error: 'Dokument ikke funnet'}
    }
    logger('info', [logPrefix, 'Dokument slettet'])
    return {status: 200, message: 'Dokument slettet'}

}

const updateDocument = async(documentId, updateData, isMock) => {
    const logPrefix = 'updateDocument'
    const mongoClient = await getMongoClient()

    // Validate documentId
    if(!documentId) {
        logger('error', [logPrefix, 'Mangler documentId'])
        return {status: 400, error: 'Mangler documentId'}
    }
    // validate updateData
    if(!updateData || Object.keys(updateData).length === 0) {
        logger('error', [logPrefix, 'Mangler updateData'])
        return {status: 400, error: 'Mangler updateData'}
    }
    
    // Check what keys are being updated
    const updatedKeys = Object.keys(updateData)
    logger('info', [logPrefix, `Oppdaterer dokument med _id: ${documentId}`, `Oppdaterer felter: ${updatedKeys.join(', ')}`])

    let result 
    if(isMock === true) {
        // Update contract in mock collection
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).updateOne({ '_id': new ObjectId(documentId) }, { $set: updateData })
    } else {
        // Update contract in collection
        result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ '_id': new ObjectId(documentId) }, { $set: updateData })
    }

    return result
}

module.exports = {
    postFormInfo,
    updateFormInfo,
    getDocuments,
    updateContractPCStatus,
    postManualContract, 
    moveAndDeleteDocument,
    updateDocument
}