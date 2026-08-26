'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  getBillingYear,
  buildFreshFakturaInfo,
  fillDocument,
  fillManualDocument,
  digitrollImportDocument
} = require('../documentSchema')

// ---- Helpers ---------------------------------------------------------------

// These builders read the system clock, so expected years are derived the same way
// rather than hardcoded — see isElevforholdActive.test.js for the same approach.
const CURRENT_YEAR = new Date().getFullYear()
const YEAR_1 = String(CURRENT_YEAR)
const YEAR_2 = String(CURRENT_YEAR + 1)
const YEAR_3 = String(CURRENT_YEAR + 2)

const UTLAAN = 'Utlån faktureres ikke'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The nested shape fillDocument expects out of the Acos form parser.
const makeFormInfo = ({ archiveData = {}, ...overrides } = {}) => ({
  refId: 'ref-123',
  acosName: 'Elevkontrakt leieavtale',
  createdTimeStamp: '2025-08-01T10:00:00.000Z',
  archive: { result: { DocumentNumber: '25/00123-1' } },
  parseXml: {
    result: {
      ArchiveData: {
        uuid: 'form-uuid-1',
        typeKontrakt: 'Leieavtale',
        FnrElev: '12345678901',
        FnrForesatt: '10987654321',
        SkoleOrgNr: '974568098',
        isError: 'false',
        isUnder18: 'true',
        ...archiveData
      }
    }
  },
  ...overrides
})

const makeElevData = (overrides = {}) => ({
  navn: 'Test Elev',
  fornavn: 'Test',
  etternavn: 'Elev',
  upn: 'test.elev@skole.telemarkfylke.no',
  elevnummer: 'E12345',
  elevforhold: [
    {
      basisgruppemedlemskap: [
        { navn: '1STA', trinn: 'VG1', skole: { navn: 'Skien videregående skole' } }
      ]
    }
  ],
  ...overrides
})

const makeAnsvarligData = (overrides = {}) => ({
  fulltnavn: 'Test Foresatt',
  foedselsEllerDNummer: '10987654321',
  ...overrides
})

const makeManualDocumentData = (overrides = {}) => ({
  type: 'Leieavtale',
  fnr: '12345678901',
  foresattFnr: '10987654321',
  schoolOrgNumber: '974568098',
  ...overrides
})

const makeFakturaEntry = (overrides = {}) => ({
  'faktureringsår': '2020',
  faktureringsDato: '13.08.2020',
  'løpenummer': '2020081613C52583368',
  sum: '3500.00',
  status: 'Betalt',
  betaltDato: '2020-08-16T00:00:00.000Z',
  ...overrides
})

const makeDigitrollData = (overrides = {}) => ({
  type: 'Leieavtale',
  avtaleId: 'DT-9001',
  filnavn: 'avtale_9001.pdf',
  createdTimeStamp: '2020-08-13T00:00:00.000Z',
  signedByName: 'Test Foresatt',
  foresatt: '10987654321',
  foresattNavn: 'Test Foresatt',
  schoolOrgNumber: '974568098',
  fakturaEntries: [],
  ...overrides
})

// =====================================================================
// getBillingYear — every rate on every Leieavtale gets its faktureringsår
// from here, so an off-by-one bills the wrong year.
// =====================================================================

describe('getBillingYear', () => {
  test('rate 1 returns the current year', () => {
    assert.equal(getBillingYear(1), YEAR_1)
  })

  test('rate 2 returns next year', () => {
    assert.equal(getBillingYear(2), YEAR_2)
  })

  test('rate 3 returns the year after next', () => {
    assert.equal(getBillingYear(3), YEAR_3)
  })

  test('returns a string, not a number', () => {
    assert.equal(typeof getBillingYear(1), 'string')
  })

  test('throws for rate 0', () => {
    assert.throws(() => getBillingYear(0), /Invalid rate value\. Rate must be 1, 2, or 3\./)
  })

  test('throws for rate 4', () => {
    assert.throws(() => getBillingYear(4), /Invalid rate value\. Rate must be 1, 2, or 3\./)
  })

  test('throws for undefined', () => {
    assert.throws(() => getBillingYear(undefined), /Invalid rate value\. Rate must be 1, 2, or 3\./)
  })

  test('throws for a numeric string, since the comparison is strict', () => {
    assert.throws(() => getBillingYear('1'), /Invalid rate value\. Rate must be 1, 2, or 3\./)
  })

  test('throws for a negative rate', () => {
    assert.throws(() => getBillingYear(-1), /Invalid rate value\. Rate must be 1, 2, or 3\./)
  })
})

// =====================================================================
// buildFreshFakturaInfo — used by the repair job to rebuild a corrupted
// fakturaInfo, so it has to match the shape a brand-new contract gets.
// =====================================================================

describe('buildFreshFakturaInfo', () => {
  test('Leieavtale gets billing years, Ikke Fakturert, and Ukjent placeholders on every rate', () => {
    const fakturaInfo = buildFreshFakturaInfo('Leieavtale')

    assert.deepEqual(fakturaInfo, {
      rate1: { 'faktureringsår': YEAR_1, faktureringsDato: 'Ukjent', status: 'Ikke Fakturert', 'løpenummer': 'Ukjent', sum: 'Ukjent', betaltDato: 'Ukjent' },
      rate2: { 'faktureringsår': YEAR_2, faktureringsDato: 'Ukjent', status: 'Ikke Fakturert', 'løpenummer': 'Ukjent', sum: 'Ukjent', betaltDato: 'Ukjent' },
      rate3: { 'faktureringsår': YEAR_3, faktureringsDato: 'Ukjent', status: 'Ikke Fakturert', 'løpenummer': 'Ukjent', sum: 'Ukjent', betaltDato: 'Ukjent' }
    })
  })

  test('Låneavtale gets Utlån faktureres ikke on every rate and omits sum and betaltDato entirely', () => {
    const fakturaInfo = buildFreshFakturaInfo('Låneavtale')

    assert.deepEqual(fakturaInfo, {
      rate1: { 'faktureringsår': UTLAAN, faktureringsDato: undefined, status: UTLAAN, 'løpenummer': undefined },
      rate2: { 'faktureringsår': UTLAAN, faktureringsDato: undefined, status: UTLAAN, 'løpenummer': undefined },
      rate3: { 'faktureringsår': UTLAAN, faktureringsDato: undefined, status: UTLAAN, 'løpenummer': undefined }
    })
  })

  test('the sum and betaltDato keys are absent for Låneavtale rather than present and undefined', () => {
    const rate1 = buildFreshFakturaInfo('Låneavtale').rate1

    assert.deepEqual(Object.keys(rate1), ['faktureringsår', 'faktureringsDato', 'status', 'løpenummer'])
  })

  test('the frontend placeholder fields are always present for Leieavtale', () => {
    const rate1 = buildFreshFakturaInfo('Leieavtale').rate1

    assert.deepEqual(Object.keys(rate1), ['faktureringsår', 'faktureringsDato', 'status', 'løpenummer', 'sum', 'betaltDato'])
  })

  test('kontraktType matching is case insensitive', () => {
    assert.equal(buildFreshFakturaInfo('leieavtale').rate1.status, 'Ikke Fakturert')
    assert.equal(buildFreshFakturaInfo('LEIEAVTALE').rate1.status, 'Ikke Fakturert')
    assert.equal(buildFreshFakturaInfo('LeieAvtale').rate1.status, 'Ikke Fakturert')
  })

  test('an undefined kontraktType falls through to the Låneavtale shape', () => {
    assert.equal(buildFreshFakturaInfo(undefined).rate1.status, UTLAAN)
  })

  test('a null kontraktType falls through to the Låneavtale shape', () => {
    assert.equal(buildFreshFakturaInfo(null).rate1.status, UTLAAN)
  })

  test('an unrecognised kontraktType is treated as not a Leieavtale', () => {
    assert.equal(buildFreshFakturaInfo('Noe helt annet').rate1.status, UTLAAN)
  })

  test('each rate object is a distinct instance, not a shared reference', () => {
    const fakturaInfo = buildFreshFakturaInfo('Leieavtale')

    assert.notEqual(fakturaInfo.rate1, fakturaInfo.rate2)
  })
})

// =====================================================================
// fillDocument — builds the document stored for every contract created
// through the Acos form flow.
// =====================================================================

describe('fillDocument', () => {
  test('maps the unsigned skjema fields from the form info', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.unSignedskjemaInfo, {
      refId: 'ref-123',
      acosName: 'Elevkontrakt leieavtale',
      kontraktType: 'Leieavtale',
      archiveDocumentNumber: '25/00123-1',
      createdTimeStamp: '2025-08-01T10:00:00.000Z'
    })
  })

  test('leaves the signed skjema fields as Ukjent at creation time', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.signedSkjemaInfo, {
      refId: 'Ukjent',
      acosName: 'Ukjent',
      kontraktType: 'Ukjent',
      archiveDocumentNumber: 'Ukjent',
      createdTimeStamp: 'Ukjent'
    })
  })

  test('leaves signedBy as Ukjent at creation time', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('sets the status flags a new unsigned contract starts with', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isSigned, 'false')
    assert.equal(document.isManualContract, 'false')
    assert.equal(document.isFakturaSent, 'false')
    assert.equal(document.isImportedToXledger, 'false')
  })

  test('takes uuid, isError and isUnder18 from the archive data', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.uuid, 'form-uuid-1')
    assert.equal(document.isError, 'false')
    assert.equal(document.isUnder18, 'true')
  })

  test('falls back to Ukjent for a missing uuid', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { uuid: undefined } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.uuid, 'Ukjent')
  })

  test('falls back to Ukjent for missing isError and isUnder18', () => {
    const formInfo = makeFormInfo({ archiveData: { isError: undefined, isUnder18: undefined } })

    const document = fillDocument(formInfo, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isError, 'Ukjent')
    assert.equal(document.isUnder18, 'Ukjent')
  })

  test('sets the sync timestamps, with only the FINT one populated', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.ok(!Number.isNaN(Date.parse(document.generatedTimeStamp)))
    assert.ok(!Number.isNaN(Date.parse(document.lastFINTSyncTimeStamp)))
    assert.equal(document.lastXledgerSyncTimeStamp, 'Ukjent')
    assert.equal(document.lastPcInfoSyncTimeStamp, 'Ukjent')
  })

  test('gotAnsvarlig is true when a foresatt fnr is present', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.gotAnsvarlig, 'true')
  })

  test('gotAnsvarlig is false when the foresatt fnr is an empty string', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { FnrForesatt: '' } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.gotAnsvarlig, 'false')
  })

  test('gotAnsvarlig is false when the foresatt fnr is absent', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { FnrForesatt: undefined } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.gotAnsvarlig, 'false')
  })

  test('isStudent and skoleOrgNr come from the school org number', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isStudent, 'true')
    assert.equal(document.skoleOrgNr, '974568098')
  })

  test('isStudent is false and skoleOrgNr Ukjent when the school org number is empty', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { SkoleOrgNr: '' } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isStudent, 'false')
    assert.equal(document.skoleOrgNr, 'Ukjent')
  })

  test('starts the pcInfo block with nothing released, returned or bought out', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.pcInfo, {
      released: 'false',
      releaseBy: 'Ukjent',
      releasedDate: 'Ukjent',
      returned: 'false',
      returnedRegisteredBy: 'Ukjent',
      returnedDate: 'Ukjent',
      boughtOut: 'false',
      buyOutBy: 'Ukjent',
      buyOutDate: 'Ukjent'
    })
  })

  test('starts the xledger import block as not imported', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.xLedgerImportInfo, { importStatus: 'false', importDate: 'Ukjent' })
  })

  test('keeps the error array that was passed in', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), ['Noe gikk galt'])

    assert.deepEqual(document.error, ['Noe gikk galt'])
  })

  test('defaults error to an empty array when undefined', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), undefined)

    assert.deepEqual(document.error, [])
  })

  // ---- fakturaInfo per kontraktType ----------------------------------------

  test('a Leieavtale gets the three billing years and Ikke Fakturert on every rate', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.fakturaInfo, {
      rate1: { 'faktureringsår': YEAR_1, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined },
      rate2: { 'faktureringsår': YEAR_2, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined },
      rate3: { 'faktureringsår': YEAR_3, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined }
    })
  })

  test('a Låneavtale is never invoiced on any rate', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { typeKontrakt: 'Låneavtale' } }), makeElevData(), makeAnsvarligData(), [])

    for (const rate of ['rate1', 'rate2', 'rate3']) {
      assert.equal(document.fakturaInfo[rate]['faktureringsår'], UTLAAN)
      assert.equal(document.fakturaInfo[rate].status, UTLAAN)
    }
  })

  test('kontraktType matching for fakturaInfo is case insensitive', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { typeKontrakt: 'leieavtale' } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.fakturaInfo.rate1.status, 'Ikke Fakturert')
  })

  test('the raw kontraktType casing is preserved on unSignedskjemaInfo even when matched case insensitively', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { typeKontrakt: 'leieavtale' } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.unSignedskjemaInfo.kontraktType, 'leieavtale')
  })

  // ---- elevInfo ------------------------------------------------------------

  test('builds elevInfo from the FINT student data', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.elevInfo, {
      navn: 'Test Elev',
      fornavn: 'Test',
      etternavn: 'Elev',
      upn: 'test.elev@skole.telemarkfylke.no',
      fnr: '12345678901',
      elevnr: 'E12345',
      skole: 'Skien videregående skole',
      klasse: '1STA',
      trinn: 'VG1'
    })
  })

  test('takes the student fnr from the form archive data, not from the FINT data', () => {
    const elevData = makeElevData({ fnr: '99999999999' })

    const document = fillDocument(makeFormInfo({ archiveData: { FnrElev: '12345678901' } }), elevData, makeAnsvarligData(), [])

    assert.equal(document.elevInfo.fnr, '12345678901')
  })

  test('falls back to Ukjent for a missing student fnr in the archive data', () => {
    const document = fillDocument(makeFormInfo({ archiveData: { FnrElev: undefined } }), makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.fnr, 'Ukjent')
  })

  test('leaves elevInfo undefined when the student lookup returned 404', () => {
    const document = fillDocument(makeFormInfo(), { status: 404 }, makeAnsvarligData(), [])

    assert.equal(document.elevInfo, undefined)
  })

  test('still builds elevInfo when elevData is undefined, falling back to Ukjent throughout', () => {
    const document = fillDocument(makeFormInfo(), undefined, makeAnsvarligData(), [])

    assert.equal(document.elevInfo.navn, 'Ukjent')
    assert.equal(document.elevInfo.upn, 'Ukjent')
    assert.equal(document.elevInfo.elevnr, 'Ukjent')
    assert.equal(document.elevInfo.fnr, '12345678901')
  })

  test('sets skole, klasse and trinn to Ukjent when elevforhold is missing', () => {
    const document = fillDocument(makeFormInfo(), makeElevData({ elevforhold: undefined }), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.skole, 'Ukjent')
    assert.equal(document.elevInfo.klasse, 'Ukjent')
    assert.equal(document.elevInfo.trinn, 'Ukjent')
  })

  test('falls back to Ukjent per field when the basisgruppemedlemskap entry is incomplete', () => {
    const elevData = makeElevData({ elevforhold: [{ basisgruppemedlemskap: [{ navn: '1STA' }] }] })

    const document = fillDocument(makeFormInfo(), elevData, makeAnsvarligData(), [])

    assert.equal(document.elevInfo.klasse, '1STA')
    assert.equal(document.elevInfo.skole, 'Ukjent')
    assert.equal(document.elevInfo.trinn, 'Ukjent')
  })

  test('falls back to Ukjent when elevforhold is an empty array', () => {
    const document = fillDocument(makeFormInfo(), makeElevData({ elevforhold: [] }), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.skole, 'Ukjent')
    assert.equal(document.elevInfo.klasse, 'Ukjent')
    assert.equal(document.elevInfo.trinn, 'Ukjent')
  })

  test('reads only the first elevforhold and the first basisgruppemedlemskap', () => {
    const elevData = makeElevData({
      elevforhold: [
        { basisgruppemedlemskap: [{ navn: 'FØRSTE', trinn: 'VG1', skole: { navn: 'Første skole' } }, { navn: 'ANDRE' }] },
        { basisgruppemedlemskap: [{ navn: 'TREDJE' }] }
      ]
    })

    const document = fillDocument(makeFormInfo(), elevData, makeAnsvarligData(), [])

    assert.equal(document.elevInfo.klasse, 'FØRSTE')
    assert.equal(document.elevInfo.skole, 'Første skole')
  })

  // ---- ansvarligInfo -------------------------------------------------------

  test('builds ansvarligInfo with the name from FREG and the fnr from the form', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.ansvarligInfo, { navn: 'Test Foresatt', fnr: '10987654321' })
  })

  test('leaves ansvarligInfo undefined when no ansvarlig data is given', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), undefined, [])

    assert.equal(document.ansvarligInfo, undefined)
  })

  test('falls back to Ukjent for a missing ansvarlig name', () => {
    const document = fillDocument(makeFormInfo(), makeElevData(), makeAnsvarligData({ fulltnavn: undefined }), [])

    assert.equal(document.ansvarligInfo.navn, 'Ukjent')
  })

  test('falls back to Ukjent for a missing foresatt fnr in the archive data', () => {
    const formInfo = makeFormInfo({ archiveData: { FnrForesatt: undefined } })

    const document = fillDocument(formInfo, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.ansvarligInfo.fnr, 'Ukjent')
  })
})

// =====================================================================
// fillManualDocument — the contract an administrator registers by hand,
// which arrives already signed.
// =====================================================================

describe('fillManualDocument', () => {
  test('defaults error to an empty array when undefined', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), undefined)

    assert.deepEqual(document.error, [])
  })

  test('keeps the error array that was passed in', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), ['feil'])

    assert.deepEqual(document.error, ['feil'])
  })

  test('falls back to Ukjent for signedBy when no ansvarlig data is given', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), undefined, [])

    assert.deepEqual(document.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('takes signedBy from the ansvarlig data', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.signedBy, { navn: 'Test Foresatt', fnr: '10987654321' })
  })

  test('is marked as a signed manual contract', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isSigned, 'true')
    assert.equal(document.isManualContract, 'true')
    assert.equal(document.isFakturaSent, 'false')
    assert.equal(document.isImportedToXledger, 'false')
  })

  test('generates a uuid', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.match(document.uuid, UUID_PATTERN)
  })

  test('generates a different uuid for each call', () => {
    const first = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])
    const second = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.notEqual(first.uuid, second.uuid)
  })

  test('marks both skjema blocks as a manual contract document with the given kontraktType', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.unSignedskjemaInfo.acosName, 'Manuelt kontraktsdokument')
    assert.equal(document.signedSkjemaInfo.acosName, 'Manuelt kontraktsdokument')
    assert.equal(document.unSignedskjemaInfo.kontraktType, 'Leieavtale')
    assert.equal(document.signedSkjemaInfo.kontraktType, 'Leieavtale')
  })

  test('takes the signed archive document number from the archive data', () => {
    const document = fillManualDocument(makeManualDocumentData(), { DocumentNumber: '25/00456-1' }, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.signedSkjemaInfo.archiveDocumentNumber, '25/00456-1')
    assert.equal(document.unSignedskjemaInfo.archiveDocumentNumber, 'Ukjent')
  })

  test('falls back to Ukjent when the archive data has no document number', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.signedSkjemaInfo.archiveDocumentNumber, 'Ukjent')
  })

  test('stamps the signed timestamp at creation and leaves the unsigned one Ukjent', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.ok(!Number.isNaN(Date.parse(document.signedSkjemaInfo.createdTimeStamp)))
    assert.equal(document.unSignedskjemaInfo.createdTimeStamp, 'Ukjent')
  })

  test('gotAnsvarlig is true when a foresatt fnr is given and false when it is empty', () => {
    const withAnsvarlig = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])
    const withoutAnsvarlig = fillManualDocument(makeManualDocumentData({ foresattFnr: '' }), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(withAnsvarlig.gotAnsvarlig, 'true')
    assert.equal(withoutAnsvarlig.gotAnsvarlig, 'false')
  })

  test('isStudent and skoleOrgNr come from the school org number', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isStudent, 'true')
    assert.equal(document.skoleOrgNr, '974568098')
  })

  test('isStudent is false when the school org number is empty', () => {
    const document = fillManualDocument(makeManualDocumentData({ schoolOrgNumber: '' }), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.isStudent, 'false')
    assert.equal(document.skoleOrgNr, 'Ukjent')
  })

  test('a Leieavtale gets the three billing years and Ikke Fakturert on every rate', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.fakturaInfo, {
      rate1: { 'faktureringsår': YEAR_1, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined },
      rate2: { 'faktureringsår': YEAR_2, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined },
      rate3: { 'faktureringsår': YEAR_3, faktureringsDato: undefined, status: 'Ikke Fakturert', 'løpenummer': undefined }
    })
  })

  test('a Låneavtale is never invoiced on any rate', () => {
    const document = fillManualDocument(makeManualDocumentData({ type: 'Låneavtale' }), {}, makeElevData(), makeAnsvarligData(), [])

    for (const rate of ['rate1', 'rate2', 'rate3']) {
      assert.equal(document.fakturaInfo[rate].status, UTLAAN)
    }
  })

  test('takes the student fnr from the document data rather than the FINT data', () => {
    const document = fillManualDocument(makeManualDocumentData({ fnr: '12345678901' }), {}, makeElevData({ fnr: '99999999999' }), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.fnr, '12345678901')
  })

  test('leaves elevInfo undefined when the student lookup returned 404', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, { status: 404 }, makeAnsvarligData(), [])

    assert.equal(document.elevInfo, undefined)
  })

  test('still builds elevInfo when elevData is undefined, falling back to Ukjent throughout', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, undefined, makeAnsvarligData(), [])

    assert.equal(document.elevInfo.navn, 'Ukjent')
    assert.equal(document.elevInfo.upn, 'Ukjent')
    assert.equal(document.elevInfo.elevnr, 'Ukjent')
    assert.equal(document.elevInfo.skole, 'Ukjent')
    assert.equal(document.elevInfo.fnr, '12345678901')
  })

  test('reads skole, klasse and trinn from the first basisgruppemedlemskap', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.skole, 'Skien videregående skole')
    assert.equal(document.elevInfo.klasse, '1STA')
    assert.equal(document.elevInfo.trinn, 'VG1')
  })

  test('sets skole, klasse and trinn to Ukjent when elevforhold is missing', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData({ elevforhold: undefined }), makeAnsvarligData(), [])

    assert.equal(document.elevInfo.skole, 'Ukjent')
    assert.equal(document.elevInfo.klasse, 'Ukjent')
    assert.equal(document.elevInfo.trinn, 'Ukjent')
  })

  test('builds ansvarligInfo from the ansvarlig data', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.deepEqual(document.ansvarligInfo, { navn: 'Test Foresatt', fnr: '10987654321' })
  })

  test('leaves ansvarligInfo undefined when no ansvarlig data is given', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), undefined, [])

    assert.equal(document.ansvarligInfo, undefined)
  })

  test('starts the pcInfo block with nothing released, returned or bought out', () => {
    const document = fillManualDocument(makeManualDocumentData(), {}, makeElevData(), makeAnsvarligData(), [])

    assert.equal(document.pcInfo.released, 'false')
    assert.equal(document.pcInfo.returned, 'false')
    assert.equal(document.pcInfo.boughtOut, 'false')
  })
})

// =====================================================================
// digitrollImportDocument — the migration path from the legacy Digitroll
// system. handleStatusField translates Digitroll's payment vocabulary into
// this system's, and a wrong translation either re-bills a paid rate or
// writes off an unpaid one.
// =====================================================================

describe('digitrollImportDocument - handleStatusField', () => {
  const statusOf = (entry, type = 'Leieavtale') => {
    const documentData = makeDigitrollData({ type, fakturaEntries: [entry] })
    return digitrollImportDocument(documentData, makeAnsvarligData()).fakturaInfo.rate1.status
  }

  test('a missing entry on a Leieavtale means not yet invoiced', () => {
    assert.equal(statusOf(undefined, 'Leieavtale'), 'Ikke Fakturert')
  })

  test('a missing entry on a Låneavtale means never invoiced', () => {
    assert.equal(statusOf(undefined, 'Låneavtale'), UTLAAN)
  })

  test('a Låneavtale is never invoiced regardless of the Digitroll status', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Betalt' }), 'Låneavtale'), UTLAAN)
    assert.equal(statusOf(makeFakturaEntry({ status: 'Ikke betalt' }), 'Låneavtale'), UTLAAN)
    assert.equal(statusOf(makeFakturaEntry({ status: 'Overført inkasso' }), 'Låneavtale'), UTLAAN)
  })

  test('Betalt maps to Betalt', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Betalt' })), 'Betalt')
  })

  test('Overført inkasso is carried over as is, counting as paid', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Overført inkasso' })), 'Overført inkasso')
  })

  test('Overført faktura counts as paid, since it was transferred to Xledger', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Overført faktura' })), 'Betalt')
  })

  test('Ikke betalt maps to Ikke Fakturert so the rate is picked up by the invoice flow', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Ikke betalt' })), 'Ikke Fakturert')
  })

  test('Skal ikke betale is carried over as is', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'Skal ikke betale' })), 'Skal ikke betale')
  })

  test('the status comparison is case insensitive', () => {
    assert.equal(statusOf(makeFakturaEntry({ status: 'BETALT' })), 'Betalt')
    assert.equal(statusOf(makeFakturaEntry({ status: 'betalt' })), 'Betalt')
    assert.equal(statusOf(makeFakturaEntry({ status: 'OVERFØRT FAKTURA' })), 'Betalt')
    assert.equal(statusOf(makeFakturaEntry({ status: 'ikke betalt' })), 'Ikke Fakturert')
    assert.equal(statusOf(makeFakturaEntry({ status: 'SKAL IKKE BETALE' })), 'Skal ikke betale')
  })

  test('the kontraktType comparison is case insensitive', () => {
    assert.equal(statusOf(undefined, 'låneavtale'), UTLAAN)
    assert.equal(statusOf(undefined, 'LÅNEAVTALE'), UTLAAN)
    assert.equal(statusOf(undefined, 'leieavtale'), 'Ikke Fakturert')
  })

  test('an unrecognised Digitroll status yields no status at all (current behaviour)', () => {
    // handleStatusField has no final fallback, so an unknown value falls off the end
    // and the rate is stored with status undefined.
    assert.equal(statusOf(makeFakturaEntry({ status: 'Noe helt annet' })), undefined)
  })
})

describe('digitrollImportDocument', () => {
  test('maps each fakturaEntry onto the matching rate', () => {
    const documentData = makeDigitrollData({
      fakturaEntries: [
        makeFakturaEntry({ 'faktureringsår': '2020', sum: '3500.00', status: 'Betalt' }),
        makeFakturaEntry({ 'faktureringsår': '2021', sum: '3600.00', status: 'Overført faktura' }),
        makeFakturaEntry({ 'faktureringsår': '2022', sum: '3700.00', status: 'Ikke betalt' })
      ]
    })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.equal(document.fakturaInfo.rate1['faktureringsår'], '2020')
    assert.equal(document.fakturaInfo.rate1.sum, '3500.00')
    assert.equal(document.fakturaInfo.rate1.status, 'Betalt')
    assert.equal(document.fakturaInfo.rate2['faktureringsår'], '2021')
    assert.equal(document.fakturaInfo.rate2.status, 'Betalt')
    assert.equal(document.fakturaInfo.rate3['faktureringsår'], '2022')
    assert.equal(document.fakturaInfo.rate3.status, 'Ikke Fakturert')
  })

  test('carries every field of a rate across from the Digitroll entry', () => {
    const documentData = makeDigitrollData({ fakturaEntries: [makeFakturaEntry()] })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.deepEqual(document.fakturaInfo.rate1, {
      'faktureringsår': '2020',
      faktureringsDato: '13.08.2020',
      betaltDato: '2020-08-16T00:00:00.000Z',
      status: 'Betalt',
      sum: '3500.00',
      'løpenummer': '2020081613C52583368'
    })
  })

  test('falls back to Ukjent per field for rates with no Digitroll entry', () => {
    const documentData = makeDigitrollData({ fakturaEntries: [makeFakturaEntry()] })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.equal(document.fakturaInfo.rate2['faktureringsår'], 'Ukjent')
    assert.equal(document.fakturaInfo.rate2.faktureringsDato, 'Ukjent')
    assert.equal(document.fakturaInfo.rate2.betaltDato, 'Ukjent')
    assert.equal(document.fakturaInfo.rate2.sum, 'Ukjent')
    assert.equal(document.fakturaInfo.rate2['løpenummer'], 'Ukjent')
  })

  test('falls back to Ukjent for individual missing fields on a present entry', () => {
    const entry = makeFakturaEntry({ betaltDato: undefined, 'løpenummer': undefined })
    const documentData = makeDigitrollData({ fakturaEntries: [entry] })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.equal(document.fakturaInfo.rate1.betaltDato, 'Ukjent')
    assert.equal(document.fakturaInfo.rate1['løpenummer'], 'Ukjent')
    assert.equal(document.fakturaInfo.rate1.status, 'Betalt')
  })

  test('handles an empty fakturaEntries array by marking a Leieavtale as not yet invoiced', () => {
    const document = digitrollImportDocument(makeDigitrollData({ fakturaEntries: [] }), makeAnsvarligData())

    assert.equal(document.fakturaInfo.rate1.status, 'Ikke Fakturert')
    assert.equal(document.fakturaInfo.rate1['faktureringsår'], 'Ukjent')
  })

  // Regression: Digitroll leaves ExtKvittering/Sum/Betalingsbeskrivelse empty for a låneavtale, so
  // importDigitrollStudents.js synthesizes all three fakturaEntries with a running calendar year and
  // 'Ukjent' everywhere else. handleStatusField already forced status to UTLAAN, but faktureringsår
  // was copied through raw, leaving every imported Låneavtale half-canonical — which
  // applyHistoricalFakturaInfo then copied onto brand-new contracts.
  test('a Låneavtale never carries a real faktureringsår, even when the Digitroll entry has one', () => {
    const documentData = makeDigitrollData({
      type: 'Låneavtale',
      fakturaEntries: [
        makeFakturaEntry({ 'faktureringsår': '2020' }),
        makeFakturaEntry({ 'faktureringsår': '2021' }),
        makeFakturaEntry({ 'faktureringsår': '2022' })
      ]
    })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    for (const rateKey of ['rate1', 'rate2', 'rate3']) {
      assert.equal(document.fakturaInfo[rateKey]['faktureringsår'], UTLAAN)
      assert.equal(document.fakturaInfo[rateKey].status, UTLAAN)
    }
  })

  test('a Låneavtale built from synthesized filler entries is canonical on every rate', () => {
    // The exact shape importDigitrollStudents.js:500-517 produces when a contract has no paid rows.
    const filler = (year) => ({ 'faktureringsår': year, faktureringsDato: 'Ukjent', 'løpenummer': 'Ukjent', status: 'Ikke Fakturert', sum: 'Ukjent', betaltDato: 'Ukjent' })
    const documentData = makeDigitrollData({
      type: 'Låneavtale',
      fakturaEntries: [filler(YEAR_1), filler(YEAR_2), filler(YEAR_3)]
    })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    for (const rateKey of ['rate1', 'rate2', 'rate3']) {
      assert.equal(document.fakturaInfo[rateKey]['faktureringsår'], UTLAAN)
      assert.equal(document.fakturaInfo[rateKey].status, UTLAAN)
    }
  })

  test('a Låneavtale with no Digitroll entries at all is canonical on every rate', () => {
    const document = digitrollImportDocument(makeDigitrollData({ type: 'Låneavtale', fakturaEntries: [] }), makeAnsvarligData())

    for (const rateKey of ['rate1', 'rate2', 'rate3']) {
      assert.equal(document.fakturaInfo[rateKey]['faktureringsår'], UTLAAN)
      assert.equal(document.fakturaInfo[rateKey].status, UTLAAN)
    }
  })

  test('a Leieavtale still gets its faktureringsår straight from the Digitroll entry', () => {
    const documentData = makeDigitrollData({
      type: 'Leieavtale',
      fakturaEntries: [makeFakturaEntry({ 'faktureringsår': '2020' })]
    })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.equal(document.fakturaInfo.rate1['faktureringsår'], '2020')
    assert.equal(document.fakturaInfo.rate2['faktureringsår'], 'Ukjent')
  })

  test('is marked as an imported, signed, already-invoiced contract', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.equal(document.isSigned, 'true')
    assert.equal(document.isManualContract, 'false')
    assert.equal(document.isFakturaSent, 'true')
    assert.equal(document.isImportedFromDigiTroll, 'true')
    assert.equal(document.isImportedToXledger, 'false')
  })

  test('generates a uuid and stamps the generated timestamp', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.match(document.uuid, UUID_PATTERN)
    assert.ok(!Number.isNaN(Date.parse(document.generatedTimeStamp)))
  })

  test('puts the Digitroll avtale id and filename on both skjema blocks', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.deepEqual(document.unSignedskjemaInfo, {
      refId: 'DT-9001',
      acosName: 'avtale_9001.pdf',
      kontraktType: 'Leieavtale',
      archiveDocumentNumber: 'Ukjent',
      createdTimeStamp: '2020-08-13T00:00:00.000Z'
    })
    assert.deepEqual(document.signedSkjemaInfo, document.unSignedskjemaInfo)
  })

  test('falls back to Ukjent across the skjema blocks when the Digitroll fields are missing', () => {
    const documentData = makeDigitrollData({ avtaleId: undefined, filnavn: undefined, type: 'Leieavtale', createdTimeStamp: undefined })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.equal(document.unSignedskjemaInfo.refId, 'Ukjent')
    assert.equal(document.unSignedskjemaInfo.acosName, 'Ukjent')
    assert.equal(document.unSignedskjemaInfo.createdTimeStamp, 'Ukjent')
  })

  test('takes signedBy navn from Digitroll and the fnr from the ansvarlig lookup', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.deepEqual(document.signedBy, { navn: 'Test Foresatt', fnr: '10987654321' })
  })

  test('falls back to Ukjent for signedBy when Digitroll has no signer name', () => {
    const document = digitrollImportDocument(makeDigitrollData({ signedByName: undefined }), makeAnsvarligData({ foedselsEllerDNummer: undefined }))

    assert.deepEqual(document.signedBy, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('gotAnsvarlig is false only when the foresatt field is an empty string', () => {
    const withForesatt = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())
    const withoutForesatt = digitrollImportDocument(makeDigitrollData({ foresatt: '' }), makeAnsvarligData())

    assert.equal(withForesatt.gotAnsvarlig, 'true')
    assert.equal(withoutForesatt.gotAnsvarlig, 'false')
  })

  test('isStudent and skoleOrgNr come from the school org number', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.equal(document.isStudent, 'true')
    assert.equal(document.skoleOrgNr, '974568098')
  })

  test('keeps the raw Digitroll payload for reference', () => {
    const raw = { 'Avtale ID': '9001', 'Signert av': 'Test Foresatt' }

    const document = digitrollImportDocument(makeDigitrollData({ digitrollData: raw }), makeAnsvarligData())

    assert.equal(document.digiTrollData, raw)
  })

  test('starts with an empty error array regardless of the input', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.deepEqual(document.error, [])
  })

  test('starts the pcInfo block with nothing released, returned or bought out', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.equal(document.pcInfo.released, 'false')
    assert.equal(document.pcInfo.returned, 'false')
    assert.equal(document.pcInfo.boughtOut, 'false')
  })

  // ---- elevInfo — note the flat elevforhold shape, unlike fillDocument -----

  test('builds elevInfo from a flat elevforhold object, not the nested FINT shape', () => {
    const elevData = {
      navn: 'Test Elev',
      fornavn: 'Test',
      etternavn: 'Elev',
      upn: 'test.elev@skole.telemarkfylke.no',
      fnr: '12345678901',
      elevnummer: 'E12345',
      elevforhold: { skole: 'Skien videregående skole', klasse: '1STA', trinn: 'VG1' }
    }

    const document = digitrollImportDocument(makeDigitrollData({ elevData }), makeAnsvarligData())

    assert.deepEqual(document.elevInfo, {
      navn: 'Test Elev',
      fornavn: 'Test',
      etternavn: 'Elev',
      upn: 'test.elev@skole.telemarkfylke.no',
      fnr: '12345678901',
      elevnr: 'E12345',
      skole: 'Skien videregående skole',
      klasse: '1STA',
      trinn: 'VG1'
    })
  })

  test('takes the student fnr from the nested elevData, unlike fillDocument which reads the form', () => {
    const document = digitrollImportDocument(makeDigitrollData({ elevData: { fnr: '12345678901' } }), makeAnsvarligData())

    assert.equal(document.elevInfo.fnr, '12345678901')
  })

  test('leaves elevInfo undefined when there is no elevData at all', () => {
    const document = digitrollImportDocument(makeDigitrollData(), makeAnsvarligData())

    assert.equal(document.elevInfo, undefined)
  })

  test('omits skole, klasse and trinn entirely when elevforhold is missing', () => {
    const document = digitrollImportDocument(makeDigitrollData({ elevData: { navn: 'Test Elev' } }), makeAnsvarligData())

    assert.equal(document.elevInfo.navn, 'Test Elev')
    assert.equal('skole' in document.elevInfo, false)
    assert.equal('klasse' in document.elevInfo, false)
    assert.equal('trinn' in document.elevInfo, false)
  })

  test('falls back to Ukjent per field for an incomplete elevData', () => {
    const document = digitrollImportDocument(makeDigitrollData({ elevData: { navn: 'Test Elev' } }), makeAnsvarligData())

    assert.equal(document.elevInfo.fornavn, 'Ukjent')
    assert.equal(document.elevInfo.upn, 'Ukjent')
    assert.equal(document.elevInfo.fnr, 'Ukjent')
    assert.equal(document.elevInfo.elevnr, 'Ukjent')
  })

  // ---- ansvarligInfo -------------------------------------------------------

  test('takes ansvarligInfo from the Digitroll fields when ansvarlig data is given', () => {
    const documentData = makeDigitrollData({ foresattNavn: 'Digitroll Foresatt', foresatt: '10987654321' })

    const document = digitrollImportDocument(documentData, makeAnsvarligData({ fulltnavn: 'FREG Foresatt' }))

    assert.deepEqual(document.ansvarligInfo, { navn: 'Digitroll Foresatt', fnr: '10987654321' })
  })

  test('yields an Ukjent ansvarligInfo when no ansvarlig data is given (current behaviour)', () => {
    // The branch reads from ansvarligData in the case where it is known to be undefined,
    // so this path can only ever produce Ukjent — the Digitroll fields are ignored here.
    const documentData = makeDigitrollData({ foresattNavn: 'Digitroll Foresatt', foresatt: '10987654321' })

    const document = digitrollImportDocument(documentData, undefined)

    assert.deepEqual(document.ansvarligInfo, { navn: 'Ukjent', fnr: 'Ukjent' })
  })

  test('falls back to Ukjent when the Digitroll foresatt fields are missing', () => {
    const documentData = makeDigitrollData({ foresattNavn: undefined, foresatt: undefined })

    const document = digitrollImportDocument(documentData, makeAnsvarligData())

    assert.deepEqual(document.ansvarligInfo, { navn: 'Ukjent', fnr: 'Ukjent' })
  })
})
