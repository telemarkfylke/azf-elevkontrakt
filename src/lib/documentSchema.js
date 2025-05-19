/**
 * 
 * @param {Number} rate - The rate for which to calculate the billing year.
 *                         1 for the current year, 2 for the next year, and 3 for the year after that.
 * @returns {Number} - The billing year based on the current year and the rate (rate1, rate2, rate3).
 * @throws {Error} - If the rate is not 1, 2, or 3.
 */
const getBillingYear = (rate) => {
    const date = new Date()
    const year = date.getFullYear()
    let rateAdjustment = 0
    if (rate === 1) {
        rateAdjustment = 0
    } else if (rate === 2) {
        rateAdjustment = 1
    } else if (rate === 3) {
        rateAdjustment = 2
    } else {
        throw new Error('Invalid rate value. Rate must be 1, 2, or 3.')
    }
    return year + rateAdjustment
}


/**
 * Fills a document object with provided form, student, and responsible data.
 *
 * @param {Object} formInfo - Information about the form.
 * @param {Object} elevData - Data about the student.
 * @param {Object} ansvarligData - Data about the responsible person.
 * @param {Array} error - Array of error messages.
 * @returns {Object} - The filled document object.
 */
const fillDocument = (formInfo, elevData, ansvarligData, error) => {
    const document = {
        uuid: formInfo.parseXml.result.ArchiveData.uuid || 'Ukjent',
        generatedTimeStamp: new Date().toISOString(),
        isSigned: "false",
        isFakturaSent: "false",
        isError: formInfo.parseXml.result.ArchiveData.isError || 'Ukjent',
        isUnder18: formInfo.parseXml.result.ArchiveData.isUnder18 || 'Ukjent',
        gotAnsvarlig: formInfo.parseXml.result.ArchiveData.FnrForesatt.length > 0 ? "true" : "false",
        isStudent: formInfo.parseXml.result.ArchiveData.SkoleOrgNr.length > 0 ? "true" : "false",
        skoleOrgNr: formInfo.parseXml.result.ArchiveData.SkoleOrgNr || 'Ukjent',
        unSignedskjemaInfo: {
            refId: formInfo.refId || 'Ukjent',
            acosName: formInfo.acosName || 'Ukjent',
            kontraktType: formInfo.parseXml.result.ArchiveData.typeKontrakt || 'Ukjent',
            archiveDocumentNumber: formInfo.archive.result.DocumentNumber || 'Ukjent',
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
            rate1: {
                // Inneholder infomasjon om faktura, hvor mange rater du skal betale og har betalt. Hvor mye du skal betale per rate. 
                faktureringsår: formInfo.parseXml.result.ArchiveData.typeKontrakt === 'leiekontrakt' ? getBillingYear(1) : 'Utlån faktureres ikke',
            },
            rate2: {
                // Inneholder infomasjon om faktura, hvor mange rater du skal betale og har betalt. Hvor mye du skal betale per rate.
                faktureringsår: formInfo.parseXml.result.ArchiveData.typeKontrakt === 'leiekontrakt' ? getBillingYear(2) : 'Utlån faktureres ikke', 
            },
            rate3: {
                // Inneholder infomasjon om faktura, hvor mange rater du skal betale og har betalt. Hvor mye du skal betale per rate.
                faktureringsår: formInfo.parseXml.result.ArchiveData.typeKontrakt === 'leiekontrakt' ? getBillingYear(3) : 'Utlån faktureres ikke', 
            },
        },
        pcInfo: {
            released: "false",
            releaseBy: "Ukjent",
            releasedDate: "Ukjent",
            returned: "false",
            returnedRegisteredBy: "Ukjent",
            returnedDate: "Ukjent",
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

module.exports = {
    fillDocument
}