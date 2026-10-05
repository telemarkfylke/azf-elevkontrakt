const { person } = require('../queryFREG.js')
const { lookupKRR } = require('../queryKRR.js')
const { lookupEnhet } = require('../queryBrreg.js')
const { normalizeIdentifier, detectIdentifierType, isValidOrgnrChecksum, isValidFnrChecksum, isOrganisation } = require('../../helpers/identifier.js')
const { maskFnr } = require('../../helpers/maskFnr.js')
const { retry } = require('../../changeStream/retry.js')
const { getDocuments, updateDocument } = require('../queryMongoDB.js')
const { logger } = require('@vtfk/logger')
const fs = require('fs')
const path = require('path')
const { fileImport } = require('../queryXledger.js')
const { default: axios } = require('axios')
const { teams, email } = require('../../../../config.js')
const { sendEmail } = require('../postEmail.js')

/**
 * This job is responsible for creating a CSV file for importing users into Xledger.
 * The CSV file is created based on a template and includes information about the users
 * such as name, address, phone number, email, and contract details.
 * The job will also update the documents in the database to mark them as imported to Xledger.
 *
 * The job will return the CSV string and an array of documents that failed to fetch person data.
 *
 * The job will typically be run at the start of a new school year to ensure that all users are imported into Xledger.
*/

/**
 * Fetches the user import documents from the database.
 * @returns {Promise<Array>} - An array of documents that match the criteria.
*/
const getXledgerUserImportDocuments = async () => {
  const query = {
    'unSignedskjemaInfo.kontraktType': { $in: ['Leieavtale', 'leieavtale', 'låneavtale', 'Låneavtale'] }, // Only contracts of type 'Leieavtale' or 'leieavtale'
    isImportedToXledger: { $ne: true } // Not yet imported to Xledger (this school year, a job will reset this field for all documents at the start of a new school year)
  }
  try {
    const documents = await getDocuments(query, 'regular')
    return documents.result || []
  } catch (error) {
    logger('error', ['getXledgerUserImportDocuments', 'Error fetching documents from database', error])
    throw error
  }
}
/**
 * Update a document in the database to mark it as imported to Xledger.
 * @param {String} documentId - The ID of the document to update.
 * @returns {Promise<Object>} - The result of the update operation.
 */
const updateImportedDocument = async (documentId) => {
  if (!documentId) {
    throw new Error('No documentId provided')
  }
  const updateData = { isImportedToXledger: true, importedToXledgerAt: new Date() }
  try {
    const result = await updateDocument(documentId, updateData, 'regular')
    return result
  } catch (error) {
    logger('error', ['updateImportedDocument', 'Error updating document in database', error])
    throw error
  }
}

/**
 * @param {String} ssn
 * @returns {Promise<Object>} - the raw FREG response; { status, message } on failure
 */
const getPersonData = (ssn) => person(ssn)

/**
 * @param {String} ssn
 * @returns {Promise<Object>} - the raw KRR response; { status, message } on failure
 */
const getKRRData = (ssn) => lookupKRR(ssn)

/**
 * Convert a string to proper case (title case).
 *
 * @param {String} str - The string to convert.
 * @returns {String} - The string in proper case.
 */
const toProperCase = (str) => {
  if (!str) return str
  // Convert to lower case and then to title case, taking into account norwegian characters æøå
  return str.toLowerCase().replace(/(^|\s|[-.])\S/g, (match) => match.toUpperCase())
}

const addExtraZero = (num) => {
  return num < 10 ? `0${num}` : num
}

// queryFREG / queryKRR swallow their errors and hand back { status, message }, so a failed call has
// to be recognised by shape and turned into a throw for retry() to see it.
class LookupError extends Error {}

const unresolved = (reason, message) => ({ ok: false, reason, message })

/**
 * @param {Object} enhet - from lookupEnhet
 * @returns {String|null} - why the organisation cannot be invoiced, or null if it is active
 */
const getInactiveOrganisationStatus = (enhet) => {
  if (enhet.slettedato) return `slettet (${enhet.slettedato})`
  if (enhet.konkurs) return 'konkurs'
  if (enhet.underTvangsavviklingEllerTvangsopplosning) return 'under tvangsavvikling eller tvangsoppløsning'
  if (enhet.underAvvikling) return 'under avvikling'
  return null
}

/**
 * '9999' is Folkeregisteret's "Ukjent Adresse". BRREG has no such sentinel - an organisation just
 * lacks the fields - so for an org any missing address part means nobody to post an invoice to.
 *
 * @param {Object} recipient - from resolveSubledgerRecipient
 * @returns {Boolean}
 */
const needsManualReview = (recipient) => {
  if (recipient.isOrganisation) return !recipient.streetAddress || !recipient.zipCode || !recipient.city
  return recipient.zipCode === '9999'
}

/**
 * Resolves what the SL04-SYS subledger row needs about the party being invoiced.
 *
 * Routed by the identifier itself rather than ansvarligInfo.type: the type backfill stamped 'person'
 * on older contracts whose fnr is really an orgnr, and those used to go through FREG and come out as
 * a row with nothing but CompanyNo.
 *
 * Only a fully resolved recipient comes back ok. Anything else must stay unimported so the next run
 * picks it up again.
 *
 * Uses queryBrreg rather than /SyncEnterprise, which writes to P360 on every call - this job runs
 * nightly over every unimported contract.
 *
 * @param {Object} document - a contract document
 * @param {Object} [deps]
 * @returns {Promise<Object>} - { ok: true, recipient, correctedType? } or { ok: false, reason, message }
 */
const resolveSubledgerRecipient = async (document, deps = {}) => {
  const {
    getPersonData: _getPersonData = getPersonData,
    getKRRData: _getKRRData = getKRRData,
    lookupEnhet: _lookupEnhet = lookupEnhet,
    retry: _retry = retry
  } = deps
  const ansvarligInfo = document?.ansvarligInfo
  const identifier = normalizeIdentifier(ansvarligInfo?.fnr)
  const identifierType = detectIdentifierType(identifier)

  if (identifierType === null) {
    return unresolved('invalid-identifier', 'Ansvarlig mangler gyldig fødselsnummer eller organisasjonsnummer')
  }

  if (identifierType === 'orgnr') {
    if (!isValidOrgnrChecksum(identifier)) {
      return unresolved('invalid-identifier', 'Ugyldig organisasjonsnummer (feil kontrollsiffer)')
    }
    let enhet
    try {
      enhet = await _retry(() => _lookupEnhet(identifier))
    } catch (error) {
      return unresolved('lookup-failed', `Enhetsregisteret svarte ikke: ${error.message}`)
    }
    if (!enhet) return unresolved('not-found', 'Fant ikke organisasjonsnummeret i Enhetsregisteret')
    const inactiveStatus = getInactiveOrganisationStatus(enhet)
    if (inactiveStatus) return unresolved('inactive-organisation', `Organisasjonen er ${inactiveStatus} i Enhetsregisteret`)

    return {
      ok: true,
      correctedType: isOrganisation(ansvarligInfo) ? undefined : 'organisasjon',
      recipient: {
        companyNo: identifier,
        description: enhet.navn,
        streetAddress: enhet.adresse?.gateadresse || null,
        zipCode: enhet.adresse?.postnummer || null,
        city: enhet.adresse?.poststed || null,
        // Admin-entered address wins over BRREG's generic firmapost, which is often missing.
        email: ansvarligInfo?.epost && ansvarligInfo.epost !== 'Ukjent' ? ansvarligInfo.epost : enhet.epostadresse,
        phone: enhet.telefon || null,
        isOrganisation: true
      }
    }
  }

  if (!isValidFnrChecksum(identifier)) {
    return unresolved('invalid-identifier', 'Ugyldig fødselsnummer (feil kontrollsiffer)')
  }
  if (isOrganisation(ansvarligInfo)) {
    return unresolved('invalid-identifier', 'Ansvarlig er registrert som organisasjon, men har et fødselsnummer')
  }

  let personData
  try {
    personData = await _retry(async () => {
      const result = await _getPersonData(identifier)
      // Returned, not thrown - retrying a 404 would only ask FREG the same question again.
      if (result?.foedselsEllerDNummer || result?.status === 404) return result
      throw new LookupError(`Folkeregisteret svarte ikke (status ${result?.status ?? 'ukjent'})`)
    })
  } catch (error) {
    return unresolved('lookup-failed', error.message)
  }
  if (!personData?.foedselsEllerDNummer) return unresolved('not-found', 'Fant ikke personen i Folkeregisteret')

  let krrData
  try {
    krrData = await _retry(async () => {
      const result = await _getKRRData(identifier)
      if (!Array.isArray(result?.personer)) throw new LookupError(`KRR svarte ikke (status ${result?.status ?? 'ukjent'})`)
      return result.personer[0] || {}
    })
  } catch (error) {
    return unresolved('lookup-failed', error.message)
  }

  return {
    ok: true,
    recipient: {
      companyNo: personData.foedselsEllerDNummer,
      description: toProperCase(personData.fulltnavn) || null,
      streetAddress: toProperCase(personData.bostedsadresse?.gateadresse || personData.postadresse?.gateadresse) || null,
      zipCode: personData.bostedsadresse?.postnummer || personData.postadresse?.postnummer || null,
      city: toProperCase(personData.bostedsadresse?.poststed || personData.postadresse?.poststed) || null,
      email: krrData.kontaktinformasjon?.epostadresse || null,
      phone: krrData.kontaktinformasjon?.mobiltelefonnummer || null,
      isOrganisation: false
    }
  }
}

/**
 * Builds one SL04-SYS row. Single builder rather than the two near-identical object literals the
 * normal and manual-review paths used to carry, so the two can no longer drift.
 *
 * @param {Object} recipient - from resolveSubledgerRecipient
 * @param {Object} document
 * @returns {Object} - keyed by the template's header text
 */
const buildSubledgerRow = (recipient, document) => ({
  'Update Level': 2,
  'Ledger Type Imp': 'AR',
  // Notes can include additional information about the user, in our case it will be the year the
  // student or the parent is imported.
  Notes: `${new Date().getFullYear()}-${addExtraZero(new Date().getMonth() + 1)}`,
  UUID: document._id,
  CompanyNo: recipient.companyNo,
  Description: recipient.description,
  'Street Address': recipient.streetAddress,
  'Zip Code': recipient.zipCode,
  City: recipient.city,
  Phone: recipient.phone,
  'E-mail': recipient.email,
  'End Of Line': 'x'
})

/**
 * Fetch person data for all documents and create the csvstring using template literals.
 *
 * @returns {Promise<string>} - A string containing the CSV data.
 */

const createCsvString = async (csvData) => {
  const csvRows = []
  const headerRow = []

  // Get the header row from the SL04-SYS_Subledger_Import_template.csv file
  const filePath = './src/lib/csvImportTemplates/SL04-SYS_Subledger_Import_template.csv'
  const fileContent = fs.readFileSync(path.resolve(filePath), 'utf8')
  const lines = fileContent.split('\n')
  if (lines.length > 0) {
    headerRow.push(lines[0].trim())
  }

  // Add data rows
  for (const row of csvData) {
    const csvRow = []
    for (const header of headerRow[0].split(';')) {
      const trimmedHeader = header.trim()
      csvRow.push(row[trimmedHeader] !== undefined ? row[trimmedHeader] : '')
    }
    // Add the header row if it's the first row
    if (csvRows.length === 0) {
      csvRows.push(headerRow[0])
    }
    // Join the CSV row and push it to the rows array
    csvRows.push(csvRow.join(';'))
  }

  // Join rows into a single newline-delimited string so fs.writeFileSync receives a string
  return csvRows.join('\n')
}

const FAILURE_REASON_LABELS = {
  'lookup-failed': 'Oppslag feilet',
  'invalid-identifier': 'Ugyldig identifikator',
  'not-found': 'Ikke funnet',
  'inactive-organisation': 'Organisasjon ikke aktiv'
}
const MAX_FAILURE_FACTS = 50

/**
 * @param {Array} documentsThatFailed - [{ id, reason, message, identifier }]
 * @returns {Array} - adaptive card facts, lookup failures first
 */
const buildFailureFacts = (documentsThatFailed) => {
  const order = Object.keys(FAILURE_REASON_LABELS)
  const sorted = [...documentsThatFailed].sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))
  const facts = sorted.slice(0, MAX_FAILURE_FACTS).map(failed => ({
    title: String(failed.id),
    value: `${FAILURE_REASON_LABELS[failed.reason] || failed.reason}: ${failed.message} (${failed.identifier})`
  }))
  if (sorted.length > MAX_FAILURE_FACTS) {
    facts.push({ title: '…', value: `og ${sorted.length - MAX_FAILURE_FACTS} til, se loggen` })
  }
  return facts
}

/**
 * @param {Object} message - { csvDataArray, csvDataArrayForManualReview, documentsThatFailed, importError }
 */
const sendTeamsMessage = async (message) => {
  const loggerPrefix = 'sendTeamsMessage'
  const { csvDataArray, csvDataArrayForManualReview, documentsThatFailed, importError } = message
  const lookupFailures = documentsThatFailed.filter(failed => failed.reason === 'lookup-failed').length
  const warnings = []
  if (importError) {
    warnings.push(`Import av filen til Xledger feilet: ${importError}. Ingen dokumenter er markert som importert.`)
  }
  if (lookupFailures > 0) {
    warnings.push(`**${lookupFailures}** oppslag mot Folkeregisteret, KRR eller Enhetsregisteret feilet etter flere forsøk. Disse prøves igjen ved neste kjøring.`)
  }
  logger('info', [loggerPrefix, 'Preparing to send Teams message with import status'])
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
              text: 'Statusrapport - azf-elevkontrakt - Import av brukere til Xledger (SL04-SYS)',
              wrap: true,
              style: 'heading'
            },
            ...warnings.map(text => ({
              type: 'TextBlock',
              text,
              wrap: true,
              weight: 'Bolder',
              color: 'Attention'
            })),
            {
              type: 'TextBlock',
              text: `**${importError ? 0 : csvDataArray.length}** bruker(er) importert til Xledger`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `**${csvDataArrayForManualReview.length}** bruker(er) krever manuell gjennomgang før import, disse blir med ved neste kjøring om de er oppdatert`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'TextBlock',
              text: `**${documentsThatFailed.length}** bruker(er) feilet og er ikke importert, ta en sjekk på disse i databasen`,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium'
            },
            {
              type: 'FactSet',
              facts: buildFailureFacts(documentsThatFailed)
            },
            {
              type: 'Image',
              url: 'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3aTJ4cm5qbTh5cDkxdmdmaHpraWNkNnB6NG94bnJwZWJkODBuZzAzNiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/o0FR9GaP3fwcePONCT/giphy.gif',
              horizontalAlignment: 'Center'
            }
          ]
        }
      }
    ]
  }
  const headers = { contentType: 'application/vnd.microsoft.teams.card.o365connector' }
  const postStatus = await axios.post(teams.webhook, teamsMsg, { headers })
  logger('info', [loggerPrefix, 'Teams message sent with status'])
  return postStatus
}

/**
 * Create a new array with only the necessary fields for the CSV export.
 * @returns {Promise<Array>} - A new array containing only the necessary fields.
 */
const createCsvDataArray = async () => {
  const logPrefix = 'createCsvDataArray'
  const documents = await getXledgerUserImportDocuments()
  if (!documents || documents.length === 0) {
    logger('info', [logPrefix, 'No documents found for Xledger user import'])
    return ''
  }

  // Take only the 1 first for test
  // documents.splice(1)

  const csvDataArray = []
  const csvDataArrayForManualReview = []
  const documentsThatFailed = []
  for (const document of documents) {
    let result
    try {
      result = await resolveSubledgerRecipient(document)
    } catch (error) {
      result = { ok: false, reason: 'lookup-failed', message: error.message }
    }

    if (!result.ok) {
      logger('warn', [logPrefix, `Mottaker for dokument ${document._id} ble ikke løst (${result.reason})`, result.message])
      documentsThatFailed.push({
        id: document._id,
        reason: result.reason,
        message: result.message,
        identifier: maskFnr(normalizeIdentifier(document?.ansvarligInfo?.fnr) || undefined)
      })
      continue
    }

    if (result.correctedType) {
      try {
        await updateDocument(document._id, { 'ansvarligInfo.type': result.correctedType }, 'regular')
        logger('info', [logPrefix, `Rettet ansvarligInfo.type til ${result.correctedType} for dokument ${document._id}`])
      } catch (error) {
        logger('error', [logPrefix, `Klarte ikke å rette ansvarligInfo.type for dokument ${document._id}`, error.message])
      }
    }

    const recipient = result.recipient
    const csvData = buildSubledgerRow(recipient, document)

    if (needsManualReview(recipient)) {
      logger('info', [logPrefix, `Recipient for document with _id: ${document._id} has no usable address, creating CSV document for manual review`])
      csvDataArrayForManualReview.push(csvData)
    } else {
      logger('info', [logPrefix, `Fetched recipient data for document with _id: ${document._id}`])
      csvDataArray.push(csvData)
    }
  }
  let importError
  if (csvDataArray.length > 0) {
    const csvString = await createCsvString(csvDataArray)
    const fileNameForImport = `SL04-SYS_xledger_user_import_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}.csv`
    const filePath = `./src/data/xledger_files/user_import_files/${fileNameForImport}`

    fs.writeFileSync(filePath, csvString, 'utf8')
    logger('info', [logPrefix, `CSV file created at ${filePath}`])

    try {
      await fileImport('SL04-SYS', filePath, fileNameForImport)
      logger('info', [logPrefix, `File imported to Xledger successfully: ${fileNameForImport}`])
      const finishedFilePath = `./src/data/xledger_files/user_import_files/finished/${fileNameForImport}`
      fs.renameSync(filePath, finishedFilePath)
      logger('info', [logPrefix, `CSV file moved to finished folder at ${finishedFilePath}`])
    } catch (error) {
      logger('error', [logPrefix, 'Error importing file to Xledger', error])
      importError = error.message || 'ukjent feil'
    }
  } else {
    logger('info', [logPrefix, 'Ingen mottakere klare for import, hopper over filimport til Xledger'])
  }

  // Create a csv file from the csvDataArrayForManualReview if there are any documents that need manual review
  if (csvDataArrayForManualReview.length > 0) {
    const fileNameForManualReview = `SL04-SYS_xledger_user_import_manual_review_${new Date().getDate()}_${new Date().getMonth() + 1}_${new Date().getFullYear()}.csv`
    const csvStringForManualReview = await createCsvString(csvDataArrayForManualReview)
    const filePathForManualReview = `./src/data/xledger_files/user_import_files/${fileNameForManualReview}`
    fs.writeFileSync(filePathForManualReview, csvStringForManualReview, 'utf8')
    logger('info', [logPrefix, `CSV file for manual review created at ${filePathForManualReview}`])

    // Send mail to the responsible person about the manual review file
    try {
      const subject = 'Ansvarlige til manuell gjennomgang'
      const html = "Hei! <br><br>Vedlagt finner du en liste over ansvarlige som av en eller annen grunn ikke kan faktureres, navnet finner du i 'Description'-feltet. <br>Den ansvarlige kan være en elev, foresatt, en annen ansvarlig person eller en organisasjon (orgnr i CompanyNo, mangler adresse i Enhetsregisteret).<br>I JOTNE kan du søke opp den ansvarlige og finne hvilke elev det gjelder og annen relevant informasjon.<br><br>Den ansvarlige må manuelt endres i databasen, ta kontakt med system ansvarlig når du har funnet nye ansvarlige.<br><br>Mvh. JOTNE"

      function toBase64 (filePath) {
        const fileBuffer = fs.readFileSync(filePath)
        return fileBuffer.toString('base64')
      }

      const attachments = [
        {
          name: fileNameForManualReview,
          data: toBase64(filePathForManualReview),
          type: 'text/csv'
        }
      ]
      await sendEmail(email.to, email.from, subject, html, attachments)
      logger('info', [logPrefix, `Email sent about manual review file at ${filePathForManualReview}`])
    } catch (error) {
      logger('error', [logPrefix, `Error sending mail about manual review file at ${filePathForManualReview}`, error])
    }

    // After mailing, move the file to the finished folder
    const finishedFilePathForManualReview = `./src/data/xledger_files/user_import_files/finished/${fileNameForManualReview}`
    fs.renameSync(filePathForManualReview, finishedFilePathForManualReview)
    logger('info', [logPrefix, `CSV file for manual review moved to finished folder at ${finishedFilePathForManualReview}`])
  }

  // Write back to the database that the documents have been imported to Xledger
  if (!importError) {
    for (const document of csvDataArray) {
      try {
        await updateImportedDocument(document.UUID)
        logger('info', [logPrefix, `Updated document with _id: ${document.UUID} as imported to Xledger`])
      } catch (error) {
        logger('error', [logPrefix, `Error updating document with _id: ${document.UUID} as imported to Xledger`, error])
      }
    }
  }

  try {
    await sendTeamsMessage({ csvDataArray, csvDataArrayForManualReview, documentsThatFailed, importError })
  } catch (error) {
    logger('error', [logPrefix, 'Klarte ikke å sende Teams-melding', error.message])
  }
  if (importError) return
  return { csvDataArray, csvDataArrayForManualReview, documentsThatFailed }
}

module.exports = {
  createCsvDataArray,
  resolveSubledgerRecipient,
  buildSubledgerRow,
  buildFailureFacts,
  needsManualReview
}
