const { logger } = require('@vtfk/logger')
const { student } = require('./queryFINT')
const { person } = require('./queryFREG')
const { getMongoClient } = require('../auth/mongoClient.js')
const { mongoDB } = require('../../../config')
// const { getSchoolyear } = require("../helpers/getSchoolyear")
const { fillDocument, fillManualDocument } = require('../documentSchema.js')
const { ObjectId } = require('mongodb')

const updateFormInfo = async (formInfo) => {
  /*
    * Søker etter skjema i MongoDB usignert og oppdaterer det.
    * Fra formInfo kommer en unik UUID som du kan søker etter i kontrakter collection. Det usignerte og det signerte skjemaet skal ha den samme unike UUID'en.
    */
  const logPrefix = 'updateFormInfo'

  // Valider formInfo
  if (!formInfo) {
    logger('error', [logPrefix, 'Mangler formInfo'])
    return { status: 400, error: 'Mangler formInfo' }
  }
  if (!formInfo.refId) {
    logger('error', [logPrefix, 'Mangler refId', `acosName: ${formInfo.acosName}`])
    return { status: 400, error: 'Mangler refId', acosName: formInfo.acosName }
  }
  if (!formInfo.acosName) {
    logger('error', [logPrefix, 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
    return { status: 400, error: 'Mangler acosName', refId: formInfo.refId }
  }
  if (!formInfo.parseXml.result.ArchiveData.uuid || formInfo.parseXml.result.ArchiveData.uuid === '' || formInfo.parseXml.result.ArchiveData.uuid === undefined || formInfo.parseXml.result.ArchiveData.uuid === null || formInfo.parseXml.result.ArchiveData.uuid === 'null') {
    logger('error', [logPrefix, 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
    return { status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName }
  }
  if (formInfo?.archive) {
    if (!formInfo.archive.result.DocumentNumber) {
      logger('error', [logPrefix, 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
      return { status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName }
    }
  }

  let ansvarligData
  if (formInfo.parseXml.result.ArchiveData.FnrForesatt) {
    // Hent mer info om ansvarlig
    logger('info', [logPrefix, 'Henter data om ansvarlig', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
    ansvarligData = await person(formInfo.parseXml.result.ArchiveData.FnrForesatt)
  }

  const mongoClient = await getMongoClient()
  const result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ uuid: formInfo.parseXml.result.ArchiveData.uuid }, {
    $set:
        {
          isSigned: 'true',
          'signedSkjemaInfo.refId': formInfo.refId,
          'signedSkjemaInfo.acosName': formInfo.acosName,
          'signedSkjemaInfo.kontraktType': formInfo.parseXml.result.ArchiveData.typeKontrakt || 'Ukjent',
          'signedSkjemaInfo.archiveDocumentNumber': formInfo.archive.result.DocumentNumber,
          'signedSkjemaInfo.createdTimeStamp': formInfo.createdTimeStamp || 'Ukjent',
          'signedBy.navn': ansvarligData.fulltnavn || 'Ukjent',
          'signedBy.fnr': formInfo.parseXml.result.ArchiveData.FnrForesatt
        }
  })

  if (result.acknowledged !== true) {
    logger('error', [logPrefix, 'Error ved oppdatering av dokument', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
    return { status: 500, error: 'Error ved oppdatering av dokument', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid }
  } else {
    if (result.modifiedCount === 0 || result.matchedCount === 0) {
      logger('info', [logPrefix, 'Fant ikke dokument å oppdatere', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
      return { status: 404, error: 'Fant ikke dokument å oppdatere', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid }
    } else {
      logger('info', [logPrefix, 'Dokument oppdatert', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`, `uuid: ${formInfo.parseXml.result.ArchiveData.uuid}`])
      return { status: 200, message: 'Dokument oppdatert', refId: formInfo.refId, acosName: formInfo.acosName, uuid: formInfo.parseXml.result.ArchiveData.uuid }
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
  if (isMock !== true) {
    // Valider formInfo
    if (!formInfo) {
      logger('error', [logPrefix, 'Mangler formInfo'])
      return { status: 400, error: 'Mangler formInfo' }
    }
    if (!formInfo.refId) {
      logger('error', [logPrefix, 'Mangler refId', `acosName: ${formInfo.acosName}`])
      return { status: 400, error: 'Mangler refId', acosName: formInfo.acosName }
    }
    if (!formInfo.acosName) {
      logger('error', [logPrefix, 'Mangler acosName', `SkjemaID: ${formInfo.refId}`])
      return { status: 400, error: 'Mangler acosName', refId: formInfo.refId }
    }
    if (!formInfo.parseXml.result.ArchiveData.uuid || formInfo.parseXml.result.ArchiveData.uuid === '' || formInfo.parseXml.result.ArchiveData.uuid === undefined || formInfo.parseXml.result.ArchiveData.uuid === null || formInfo.parseXml.result.ArchiveData.uuid === 'null' && (!formInfo.parseXml.result.ArchiveData.isError === 'true' || !formInfo.parseXml.result.ArchiveData.isNonFixAbleError === 'true')) {
      logger('error', [logPrefix, 'Mangler UUID', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
      return { status: 400, error: 'Mangler UUID', refId: formInfo.refId, acosName: formInfo.acosName }
    }
    if (formInfo?.archive) {
      if (!formInfo.archive.result.DocumentNumber) {
        logger('error', [logPrefix, 'Mangler DocumentNumber', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        return { status: 400, error: 'Mangler DocumentNumber', refId: formInfo.refId, acosName: formInfo.acosName }
      }
    }
  }

  let elevData
  let ansvarligData
  let document
  const error = []
  // Sett docmunet = formInfo om isMock === true. Infoform er mock data
  isMock === true ? document = formInfo : document = document
  // Hvis isMock === true, skip henting av elev og ansvarlig data, vi ønsker å poste mock data til db direkte
  if (isMock !== true) {
    if (formInfo.parseXml.result.ArchiveData.FnrElev) {
      // Hent mer info om eleven
      elevData = await student(formInfo.parseXml.result.ArchiveData.FnrElev)
      logger('info', [logPrefix, 'Henter data om elev', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
      if (elevData.status === 404) {
        logger('info', [logPrefix, 'Elev ikke funnet i FINT, sjekker FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
        elevData = await person(formInfo.parseXml.result.ArchiveData.FnrElev)
        // Eleven er ikke funnet
        if (elevData === undefined) {
          logger('info', [logPrefix, 'Elev ikke funnet i FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
          error.push({ error: 'Elev ikke funnet', fnr: formInfo.parseXml.result.ArchiveData.FnrElev })
        } else {
          logger('info', [logPrefix, 'Elev ikke funnet i FINT, men vi fant data i FREG', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
          error.push({ error: 'Elev ikke funnet i FINT, men vi fant data i FREG', fnr: formInfo.parseXml.result.ArchiveData.FnrElev })
        }
      }
    }

    if (formInfo.parseXml.result.ArchiveData.FnrForesatt) {
      // Hent mer info om ansvarlig
      logger('info', [logPrefix, 'Henter data om ansvarlig', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
      ansvarligData = await person(formInfo.parseXml.result.ArchiveData.FnrForesatt)
    }
    if (ansvarligData === undefined) {
      // Ansvarlig er ikke funnet
      logger('info', [logPrefix, 'Ansvarlig ikke funnet', `SkjemaID: ${formInfo.refId}`, `acosName: ${formInfo.acosName}`])
      error.push({ error: 'Ansvarlig ikke funnet', fnr: formInfo.parseXml.result.ArchiveData.FnrForesatt })
    }

    document = fillDocument(formInfo, elevData, ansvarligData, error)
  }

  const mongoClient = await getMongoClient()

  let mongoDBCollection
  let mongoDBErrorCollection
  // Velger collection basert på om det er mock eller ikke
  if (isMock === true) {
    mongoDBCollection = `${mongoDB.contractsMockCollection}`
    mongoDBErrorCollection = `${mongoDB.errorMockCollection}`
  } else {
    mongoDBCollection = `${mongoDB.contractsCollection}`
    mongoDBErrorCollection = `${mongoDB.errorCollection}`
  }
  // Poster dokument til riktig collection
  try {
    let result
    if (document.isError === 'true' || document.isNonFixAbleError === 'true') {
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
    return { status: 500, error: 'Error poster til db', refId: formInfo.refId, acosName: formInfo.acosName }
  }
}
/**
 *
 * @param {Object} query
 * @param {string} documentType | preImport | mock | regular | løpenummer | settings | history | pcIkkeInnlevert
 * @returns
 */
const getDocuments = async (query, documentType) => {
// const getDocuments = async (query, isMock, isPreimport, løpenummer) => {
  const logPrefix = 'getDocuments'
  const mongoClient = await getMongoClient()

  if (!query || query === undefined) {
    logger('error', [logPrefix, 'Mangler query'])
    return { status: 400, error: 'Mangler query' }
  }

  if (!documentType) {
    logger('error', [logPrefix, 'Mangler documentType'])
    return { status: 400, error: 'Mangler documentType' }
  } else if (documentType !== 'mock' && documentType !== 'preImport' && documentType !== 'regular' && documentType !== 'løpenummer' && documentType !== 'settings' && documentType !== 'history' && documentType !== 'pcIkkeInnlevert') {
    logger('error', [logPrefix, 'Ugyldig documentType, må være mock, preImport, regular, løpenummer eller settings'])
    return { status: 400, error: 'Ugyldig documentType, må være mock, preImport, regular, løpenummer eller settings' }
  }

  let result
  if (documentType === 'mock') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).find(query).toArray()
  } else if (documentType === 'preImport') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.preImportDigitrollCollection}`).find(query).toArray()
  } else if (documentType === 'løpenummer') {
    result = await mongoClient.db(mongoDB.dbnameXledgerSerialNumbers).collection(`${mongoDB.serialnumberCollection}`).find(query).sort({ iterationNumber: -1 }).limit(1).toArray()
  } else if (documentType === 'settings') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.settingsCollection}`).find(query).toArray()
  } else if (documentType === 'regular') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).find(query).toArray()
  } else if (documentType === 'history') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.historicCollection}`).find(query).toArray()
  } else if (documentType === 'pcIkkeInnlevert') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.historicPcNotDeliveredCollection}`).find(query).toArray()
  } else {
    logger('error', [logPrefix, 'Ugyldig documentType, må være mock, preImport, regular, løpenummer, settings eller pcIkkeInnlevert'])
    return { status: 400, error: 'Ugyldig documentType, må være mock, preImport, regular, løpenummer, settings eller pcIkkeInnlevert' }
  }

  if (result.length === 0) {
    logger('info', [logPrefix, 'Fant ingen dokumenter'])
    return { status: 404, error: 'Fant ingen dokumenter' }
  } else {
    logger('info', [logPrefix, `Fant ${result.length} dokumenter`])
    return { status: 200, result }
  }
}
/**
 *
 * @param {String} contract | contract object from frontend
 * @param {Boolean} isMock | true | false
 * @returns
 */
const updateContractPCStatus = async (contract, isMock, targetCollection) => {
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
  if (!contract.contractID) {
    logger('error', [logPrefix, 'Mangler contractID'])
    return { status: 400, error: 'Mangler contractID' }
  }

  // Check if releasePC or returnPC is provided
  if (!contract.releasePC && !contract.returnPC && !contract.buyOutPC) {
    logger('error', [logPrefix, 'Mangler releasePC eller returnPC eller buyOutPC'])
    return { status: 400, error: 'Mangler releasePC eller returnPC eller buyOutPC' }
  }

  // If releasePC or returnPC is provided, provide the correct info
  if (contract.releasePC === 'true' || contract.releasePC === 'false') {
    logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, releasePC: ${contract.releasePC}`])
    const releasePCInfo = {
      'pcInfo.releaseBy': contract.upn,
      'pcInfo.releasedDate': new Date(),
      'pcInfo.released': contract.releasePC
    }
    pcUpdateObject = releasePCInfo
  } else if (contract.returnPC === 'true' || contract.returnPC === 'false') {
    logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, returnPC: ${contract.returnPC}`])
    const returnPCInfo = {
      'pcInfo.returnedBy': contract.upn,
      'pcInfo.returnedDate': new Date(),
      'pcInfo.returned': contract.returnPC
    }
    pcUpdateObject = returnPCInfo
  } else if (contract.buyOutPC === 'true' || contract.buyOutPC === 'false') {
    logger('info', [logPrefix, `Oppdaterer objekt med _id: ${contract.contractID}, buyOutPC: ${contract.buyOutPC}`])
    const buyOutPCInfo = {
      'pcInfo.buyOutBy': contract.upn,
      'pcInfo.buyOutDate': new Date(),
      'pcInfo.boughtOut': contract.buyOutPC
    }
    pcUpdateObject = buyOutPCInfo
  } else {
    logger('error', [logPrefix, 'Mangler releasePC eller returnPC eller buyOutPC'])
    return { status: 400, error: 'Mangler releasePC eller returnPC eller buyOutPC' }
  }

  let result
  if (isMock === true) {
    // Update contract in mock collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).updateOne({ _id: new ObjectId(contract.contractID) }, { $set: pcUpdateObject })
  } else if (targetCollection === 'pcIkkeInnlevert') {
    // Update contract in collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.historicPcNotDeliveredCollection}`).updateOne({ _id: new ObjectId(contract.contractID) }, { $set: pcUpdateObject })
  } else {
    // Update contract in collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ _id: new ObjectId(contract.contractID) }, { $set: pcUpdateObject })
  }

  return result
}

const postManualContract = async (contract, archiveData, isMock) => {
  const logPrefix = 'postManualContract'
  const mongoClient = await getMongoClient()

  // Valider contract
  if (!contract) {
    logger('error', [logPrefix, 'Mangler contract'])
    return { status: 400, error: 'Mangler contract' }
  }
  if (!archiveData || !archiveData.DocumentNumber) {
    logger('error', [logPrefix, 'Mangler archiveData eller DocumentNumber'])
    return { status: 400, error: 'Mangler archiveData eller DocumentNumber' }
  }
  let elevData
  let ansvarligData

  if (isMock !== true) {
    if (contract.fnr) {
      // Hent mer info om eleven
      elevData = await student(contract.fnr)
      logger('info', [logPrefix, 'Henter data om elev, manuell kontrakt'])
      if (elevData.status === 404) {
        logger('info', [logPrefix, 'Elev ikke funnet i FINT, sjekker FREG'])
        elevData = await person(contract.fnr)
        // Eleven er ikke funnet
        if (elevData === undefined) {
          logger('error', [logPrefix, 'Elev ikke funnet i FREG'])
          throw new Error('Elev ikke funnet')
        } else {
          logger('error', [logPrefix, 'Elev ikke funnet i FINT'])
          throw new Error('Elev ikke funnet i FINT')
        }
      }
    }

    if (contract.foresattFnr !== '') {
      // Hent mer info om ansvarlig
      logger('info', [logPrefix, 'Henter data om ansvarlig'])
      ansvarligData = await person(contract.foresattFnr)
    } else {
      logger('info', [logPrefix, 'Ingen foresatt oppgitt for manuell kontrakt, ansvarlig er da eleven selv'])
      ansvarligData = await person(contract.fnr)
    }
    if (ansvarligData === undefined) {
      // Ansvarlig er ikke funnet
      logger('info', [logPrefix, 'Ansvarlig ikke funnet'])
      throw new Error('Ansvarlig ikke funnet')
    }
  }
  // Fyll ut dokumentet med data
  const document = fillManualDocument(contract, archiveData, elevData, ansvarligData)

  let result
  try {
    if (isMock === true) {
      result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).insertOne(document)
    } else {
      result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).insertOne(document)
    }
    if (result.acknowledged !== true) {
      logger('error', [logPrefix, 'Error ved oppretting av manuelt kontraktsdokument'])
      throw new Error('Error ved oppretting av manuelt kontraktsdokument')
    } else {
      logger('info', [logPrefix, 'Manuelt kontraktsdokument opprettet'])
      return { result, document }
    }
  } catch (error) {
    logger('error', [logPrefix, 'Error poster til db', error])
    throw new Error('Error poster til db', error)
  }
}

/**
 *
 * @param {*} contract | contract object from digitroll
 * @param {*} targetCollection | historisk | kontrakter | preImportDigitroll
 * @param {*} contractType | låneavtale | leieavtale
 * @returns
 */
const postDigitrollContract = async (contract, targetCollection, contractType) => {
  // Validate inputs
  const logPrefix = 'postDigitrollContract'
  const mongoClient = await getMongoClient()
  if (!contract) {
    logger('error', [logPrefix, 'Mangler contract'])
    return { status: 400, error: 'Mangler contract' }
  }
  if (!targetCollection) {
    logger('error', [logPrefix, 'Mangler targetCollection'])
    return { status: 400, error: 'Mangler targetCollection' }
  }

  if (targetCollection === 'historisk') {
    targetCollection = mongoDB.historicCollection
  } else if (targetCollection === 'kontrakter') {
    targetCollection = mongoDB.contractsCollection
  } else if (targetCollection === 'preImportDigitroll') {
    targetCollection = mongoDB.preImportDigitrollCollection
    if (contractType !== 'låneavtale' && contractType !== 'leieavtale') {
      logger('error', [logPrefix, 'For preImportDigitroll, må contractType være låneavtale eller leieavtale'])
      return { status: 400, error: 'For preImportDigitroll, må contractType være låneavtale eller leieavtale' }
    }
  } else {
    logger('error', [logPrefix, 'Ugyldig targetCollection'])
    return { status: 400, error: 'Ugyldig targetCollection' }
  }

  let result
  try {
    if (targetCollection === 'preImportDigitroll') {
      result = await mongoClient.db(mongoDB.dbName).collection(`${targetCollection}-${contractType}`).insertOne(contract)
    } else {
      result = await mongoClient.db(mongoDB.dbName).collection(`${targetCollection}`).insertOne(contract)
    }
    if (result.acknowledged !== true) {
      logger('error', [logPrefix, 'Error ved oppretting av manuelt kontraktsdokument'])
      throw new Error('Error ved oppretting av manuelt kontraktsdokument')
    } else {
      logger('info', [logPrefix, 'Manuelt kontraktsdokument opprettet'])
      return { result, document: contract.Navn }
    }
  } catch (error) {
    logger('error', [logPrefix, 'Error ved posting til db', `Contract Navn: ${contract.Navn}`, error])
    throw new Error('Error ved posting til db', error)
  }
}

/**
 * Flytt et dokument til en annen collection og slett det fra den opprinnelige collection
 * @param {*} documentId | _id til dokumentet som skal slettes
 * @param {*} targetCollection | deleted | historic
 * @param {*} isMock | true | false
 * @returns
 */

const moveAndDeleteDocument = async (documentId, targetCollection, isMock, isPreImport) => {
  const logPrefix = 'moveAndDeleteDocument'
  const mongoClient = await getMongoClient()

  // Valider documentId
  if (!documentId) {
    logger('error', [logPrefix, 'Mangler documentId'])
    return { status: 400, error: 'Mangler documentId' }
  }
  // Valider targetCollection
  if (!targetCollection) {
    logger('error', [logPrefix, 'Mangler targetCollection'])
    return { status: 400, error: 'Mangler targetCollection' }
  }

  const moveDocumentToTargetCollection = async (documentId, targetCollection, isMock, isPreImport) => {
    // Find document in the collection you want to delete from. If isMock === true, search in mock collection
    let docToMove
    if (isPreImport === true) {
      logger('info', [logPrefix, `Leter etter dokument med _id: ${documentId} i ${mongoDB.preImportDigitrollCollection} collection`])
      docToMove = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.preImportDigitrollCollection}`).findOne({ _id: new ObjectId(documentId) })
    } else if (isMock === true) {
      logger('info', [logPrefix, `Leter etter dokument med _id: ${documentId} i ${isMock ? mongoDB.contractsMockCollection : mongoDB.contractsCollection} collection`])
      docToMove = await mongoClient.db(mongoDB.dbName).collection(`${isMock ? mongoDB.contractsMockCollection : mongoDB.contractsCollection}`).findOne({ _id: new ObjectId(documentId) })
    } else {
      logger('info', [logPrefix, `Leter etter dokument med _id: ${documentId} i ${mongoDB.contractsCollection} collection`])
      docToMove = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).findOne({ _id: new ObjectId(documentId) })
    }

    if (!docToMove) {
      logger('error', [logPrefix, 'Dokument ikke funnet for flytting'])
      return { status: 404, error: 'Dokument ikke funnet for flytting' }
    }
    // Sjekk om deleted collection finnes, hvis ikke, opprett den
    let collection = ''
    // const deletedCollection = isMock ? mongoDB.deletedMockCollection : mongoDB.deletedCollection

    if (targetCollection === 'deleted') {
      collection = isMock ? mongoDB.deletedMockCollection : mongoDB.deletedCollection
    } else if (targetCollection === 'historic') {
      collection = mongoDB.historicCollection
    } else if (targetCollection === 'contracts') {
      collection = mongoDB.contractsCollection
    } else if (targetCollection === 'duplicates') {
      collection = mongoDB.duplicatesCollection
    } else if (targetCollection === 'historic-pcNotDelivered') {
      collection = mongoDB.historicPcNotDeliveredCollection
    }
    const collectionExists = await mongoClient.db(mongoDB.dbName).listCollections({ name: collection }).hasNext()
    if (!collectionExists) {
      logger('info', [logPrefix, `Oppretter target collection: ${collection}`])
      try {
        await mongoClient.db(mongoDB.dbName).createCollection(collection)
      } catch (error) {
        logger('error', [logPrefix, `Error ved oppretting av target collection: ${collection}`, error])
        return { status: 500, error: `Error ved oppretting av target collection: ${collection}` }
      }
    }
    // Flytt dokumentet til target collection
    logger('info', [logPrefix, `Flytter dokument med _id: ${documentId} til target collection: ${collection}`])
    const result = await mongoClient.db(mongoDB.dbName).collection(collection).insertOne(docToMove)
    if (result.acknowledged !== true) {
      logger('error', [logPrefix, `Error ved flytting av dokument til target collection: ${collection}`])
      return { status: 500, error: `Error ved flytting av dokument til target collection: ${collection}` }
    } else {
      logger('info', [logPrefix, `Dokument flyttet til target collection: ${collection}`])
      return { status: 200, message: `Dokument flyttet til target collection: ${collection}` }
    }
  }

  let result
  if (isMock === true) {
    // Flytt dokumentet til target collection
    const moveResult = await moveDocumentToTargetCollection(documentId, targetCollection, isMock, false)
    if (moveResult.status !== 200) {
      return moveResult
    } else {
      logger('info', [logPrefix, `Dokument flyttet til target collection: ${targetCollection}, fortsetter med sletting fra mock collection`])
      // Slett dokumentet i mock collection
      logger('info', [logPrefix, `Sletter dokument med _id: ${documentId} fra mock collection`])
      result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).deleteOne({ _id: new ObjectId(documentId) })
    }
  } else if (isPreImport === true) {
    // Flytt dokumentet til target collection
    isMock = false
    const moveResult = await moveDocumentToTargetCollection(documentId, targetCollection, isMock, true)
    if (moveResult.status !== 200) {
      return moveResult
    } else {
      logger('info', [logPrefix, `Dokument flyttet til target collection: ${targetCollection}, fortsetter med sletting fra collection`])
      // Slett dokumentet i collection
      logger('info', [logPrefix, `Sletter dokument med _id: ${documentId} fra collection`])
      result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.preImportDigitrollCollection}`).deleteOne({ _id: new ObjectId(documentId) })
    }
  } else {
    // Flytt dokumentet til target collection
    isMock = false
    const moveResult = await moveDocumentToTargetCollection(documentId, targetCollection, isMock, false)
    if (moveResult.status !== 200) {
      return moveResult
    } else {
      logger('info', [logPrefix, `Dokument flyttet til target collection: ${targetCollection}, fortsetter med sletting fra collection`])
      // Slett dokumentet i collection
      logger('info', [logPrefix, `Sletter dokument med _id: ${documentId} fra collection`])
      result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).deleteOne({ _id: new ObjectId(documentId) })
    }
  }

  if (result.deletedCount === 0) {
    logger('error', [logPrefix, 'Dokument ikke funnet'])
    return { status: 404, error: 'Dokument ikke funnet' }
  }
  logger('info', [logPrefix, 'Dokument slettet'])
  return { status: 200, message: 'Dokument slettet' }
}
/**
 *
 * @param {string} documentId
 * @param {object} updateData
 * @param {string} documentType | mock | preImport | regular | regularWithChangeLog | settings | pcIkkeInnlevert
 * @returns
 */
const updateDocument = async (documentId, updateData, documentType) => {
  const logPrefix = 'updateDocument'
  const mongoClient = await getMongoClient()

  // Validate documentId
  if (!documentId) {
    logger('error', [logPrefix, 'Mangler documentId'])
    return { status: 400, error: 'Mangler documentId' }
  }
  // validate updateData
  if (!updateData || Object.keys(updateData).length === 0) {
    logger('error', [logPrefix, 'Mangler updateData'])
    return { status: 400, error: 'Mangler updateData' }
  }

  if (!documentType) {
    logger('error', [logPrefix, 'Mangler documentType'])
    return { status: 400, error: 'Mangler documentType' }
  } else if (documentType !== 'mock' && documentType !== 'preImport' && documentType !== 'regular' && documentType !== 'regularWithChangeLog' && documentType !== 'settings' && documentType !== 'pcIkkeInnlevert') {
    logger('error', [logPrefix, 'Ugyldig documentType, må være mock, preImport, regular, regularWithChangeLog, settings eller pcIkkeInnlevert'])
    return { status: 400, error: 'Ugyldig documentType, må være mock, preImport, regular, regularWithChangeLog, settings eller pcIkkeInnlevert' }
  }

  // Check what keys are being updated
  const updatedKeys = Object.keys(updateData)
  logger('info', [logPrefix, `Oppdaterer dokument med _id: ${documentId}`, `Oppdaterer felter: ${updatedKeys.join(', ')}`])

  let result
  if (documentType === 'mock') {
    // Update contract in mock collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsMockCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData })
  } else if (documentType === 'preImport') {
    // Update contract in preImport collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.preImportDigitrollCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData })
  } else if (documentType === 'regularWithChangeLog') {
    // If changeLog is being updated, push new entry to array
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData.data, $push: { changeLog: updateData.changeLog } })
  } else if (documentType === 'regular') {
    // Update contract in collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.contractsCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData })
  } else if (documentType === 'settings') {
    // Update settings in settings collection
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.settingsCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData.data, $push: { changeLog: updateData.changeLog } })
  } else if (documentType === 'pcIkkeInnlevert') {
    result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.historicPcNotDeliveredCollection}`).updateOne({ _id: new ObjectId(documentId) }, { $set: updateData.data, $push: { changeLog: updateData.changeLog } })
  } else {
    logger('error', [logPrefix, 'Ugyldig documentType, må være mock, preImport eller regular'])
    return { status: 400, error: 'Ugyldig documentType, må være mock, preImport eller regular' }
  }

  return result
}

const deleteDocuments = async (query, collectionToDeleteFrom) => {
  const logPrefix = 'deleteDocuments'
  const mongoClient = await getMongoClient()
  if (!query || Object.keys(query).length === 0) {
    logger('error', [logPrefix, 'Mangler query'])
    return { status: 400, error: 'Mangler query' }
  }
  if (!collectionToDeleteFrom) {
    logger('error', [logPrefix, 'Mangler collectionToDeleteFrom'])
    return { status: 400, error: 'Mangler collectionToDeleteFrom' }
  }
  let collectionName = ''
  if (collectionToDeleteFrom === 'kontrakter') {
    collectionName = mongoDB.contractsCollection
  } else if (collectionToDeleteFrom === 'kontrakterMock') {
    collectionName = mongoDB.contractsMockCollection
  } else if (collectionToDeleteFrom === 'preImportDigitroll') {
    collectionName = mongoDB.preImportDigitrollCollection
  } else if (collectionToDeleteFrom === 'historisk') {
    collectionName = mongoDB.historicCollection
  }

  if (collectionName === '') {
    logger('error', [logPrefix, 'Ugyldig collectionToDeleteFrom'])
    return { status: 400, error: 'Ugyldig collectionToDeleteFrom' }
  }

  const result = await mongoClient.db(mongoDB.dbName).collection(`${collectionName}`).deleteMany(query)
  if (result.deletedCount === 0) {
    logger('info', [logPrefix, 'Ingen dokumenter slettet'])
    return { status: 404, error: 'Ingen dokumenter slettet' }
  } else {
    logger('info', [logPrefix, `Slettet ${result.deletedCount} dokumenter`])
    return { status: 200, message: `Slettet ${result.deletedCount} dokumenter` }
  }
}

const postSerialNumber = async (serialNumber) => {
  const logPrefix = 'postSerialNumber'
  const mongoClient = await getMongoClient()
  if (!serialNumber) {
    logger('error', [logPrefix, 'Mangler serialNumber'])
    return { status: 400, error: 'Mangler serialNumber' }
  }
  try {
    const result = await mongoClient.db(mongoDB.dbnameXledgerSerialNumbers).collection(`${mongoDB.serialnumberCollection}`).insertOne(serialNumber)
    if (result.acknowledged !== true) {
      logger('error', [logPrefix, 'Error ved oppretting av serialNumber'])
      throw new Error('Error ved oppretting av serialNumber')
    } else {
      logger('info', [logPrefix, 'SerialNumber opprettet'])
      return { result, document: serialNumber }
    }
  } catch (error) {
    logger('error', [logPrefix, 'Error poster til db', error])
    throw new Error('Error poster til db', error)
  }
}

const postInitialSettings = async (settings) => {
  const logPrefix = 'postInitialSettings'
  const mongoClient = await getMongoClient()
  if (!settings) {
    logger('error', [logPrefix, 'Mangler settings'])
    return { status: 400, error: 'Mangler settings' }
  }
  try {
    const result = await mongoClient.db(mongoDB.dbName).collection(`${mongoDB.settingsCollection}`).insertOne(settings)
    if (result.acknowledged !== true) {
      logger('error', [logPrefix, 'Error ved oppretting av settings'])
      throw new Error('Error ved oppretting av settings')
    } else {
      logger('info', [logPrefix, 'Settings opprettet'])
      return { result, document: settings }
    }
  } catch (error) {
    logger('error', [logPrefix, 'Error poster til db', error])
    throw new Error('Error poster til db', error)
  }
}

module.exports = {
  postFormInfo,
  updateFormInfo,
  getDocuments,
  updateContractPCStatus,
  postManualContract,
  moveAndDeleteDocument,
  updateDocument,
  postDigitrollContract,
  deleteDocuments,
  postSerialNumber,
  postInitialSettings
}
