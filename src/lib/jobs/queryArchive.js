const axios = require('axios').default
const { archive } = require('../../../config')
const getAccessToken =  require('../auth/get-endtraid-token')
const { logger } = require('@vtfk/logger')
const { schoolInfoList } = require('../datasources/tfk-schools')

// Archive the document
/**
 * Recno: 201202,
 * DocumentNumber: '23/00077-60',
 * ImportedDocumentNumber: null,
 * UID: '38cffcb5-77b7-4d9a-adf2-c669f57bb33e',
 * UIDOrigin: '360'
 *
 * @param {Object} payload
 * @returns {Promise<Object>} - The response from the archive service containing the archived document details. | archive = {
 *    Recno: 201202,
 *    DocumentNumber: '23/00077-60',
 *    ImportedDocumentNumber: null,
 *    UID: '38cffcb5-77b7-4d9a-adf2-c669f57bb33e',
 *    UIDOrigin: '360'
 * }
 * @throws {Error} - Throws an error if the document could not be archived.
 */
const archiveDocument = async (payload) => {
  const elevmappe = await syncElevMappe(payload.fnr)
  const privatePerson = await syncPrivatePerson(payload?.foresattFnr || payload.fnr)

  const school = schoolInfoList.find(school => school.orgNr === payload.schoolOrgNumber)
  const payloadToArchive = {
    service: 'DocumentService',
    method: 'CreateDocument',
    parameter: {
      title: payload.title,
      AccessCode: '13',
      AccessGroup: school.tilgangsgruppe,
      Category: "Dokument inn",
       Contacts: [ // Her vil alltid avsender være eleven, men mottaker kan være enten eleven (over 18) eller en foresatt (for elev under 18)
        {
          ReferenceNumber: elevmappe.privatePerson.ssn, // FNR til elev (innlogget i skjema)
          Role: 'Kopi til',
          IsUnofficial: true
        },
        {
          ReferenceNumber: school.orgNr, // Skolens organisasjonsnummer
          Role: 'Mottaker',
          IsUnofficial: true
        },
        {
          ReferenceNumber: privatePerson.privatePerson.ssn, // FNR til den som signerer avtalen (foresatt eller elev)
          Role: 'Avsender',
          IsUnofficial: true
        }
      ],
      DocumentDate: new Date().toISOString(),
      Files: [
        {
          Base64Data: payload.attachment,
          Category: '1',
          Format: 'pdf',
          Status: 'F',
          Title: 'Elevavtale - Signert',
          VersionFormat: 'A'
        },
      ],
      Paragraph: 'Offl. § 13 jf. fvl. § 13 (1) nr.1',
      ResponsibleEnterpriseNumber: payload.schoolOrgNumber, // Skolens organisasjonsnummer
      Status: 'J',
      Title: 'Elevavtale - Signert',
      Archive: 'Elevdokument',
      CaseNumber: elevmappe.elevmappe.CaseNumber, // Elevens mappe i arkivet
    }
  }
  const accessToken = await getAccessToken(archive.scope)
  let data
  try {
    data = await axios.post(`${archive.url}/archive`, payloadToArchive, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (error) {
    logger('error', ['archive', error]) 
  }
  return data.data
}

// Sync PrivatePerson
const syncPrivatePerson = async (ssn) => {
  const accessToken = await getAccessToken(archive.scope)
  const body = {
    ssn: ssn,
    forceUpdate: true // Set to true to force update the person in the archive
  }
  let data
  try {
    data = await axios.post(`${archive.url}/SyncPrivatePerson`, body, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (error) {
    logger('error', ['syncPrivatePerson', error])
    throw new Error('Internal server error')
  }
  return data?.data || data // Return the data or the data property if it exists
}

// Sync Elev
const syncElevMappe = async (ssn) => {
  const accessToken = await getAccessToken(archive.scope)
  // For manual testing, you can use the following body structure:
  // const body = {
  //   "fakeSsn": true,
  //   "birthdate": "yyyy-mm-dd", // Replace with actual birthdate if needed
  //   "gender": "f", // f/m
  //   "name": "fult navn", // Full name of the student
  //   "firstName": "fornavn",
  //   "lastName": "etternavn",
  //   "streetAddress": "Adresse som i p360",
  //   "zipCode": "",
  //   "zipPlace": ""
  // }
  const body = {
    ssn: ssn,
    forceUpdate: true // Set to true to force update the person in the archive
  }
  let data
  try {
    data = await axios.post(`${archive.url}/SyncElevmappe`, body, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (error) {
    logger('error', ['syncElevMappe', error])
    throw new Error('Internal server error')
  }
  return data?.data || data // Return the data or the data property if it exists
}

module.exports = {
  archiveDocument
}
