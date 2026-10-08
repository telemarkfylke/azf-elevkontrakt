// Edits allowed on rates in the history collection (payments from remisser).
const FIELD_PATTERN = /^fakturaInfo\.(rate[1-3])\.(status|betaltDato|sistInnbetaltDato|betaltBeløp|editReasonCustom)$/
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/
const STATUSES = ['Betalt', 'Overført inkasso']
const CONFLICT = 'Avtalen er endret av noen andre. Last inn siden på nytt og prøv igjen.'
const FIRST_DATE = Date.parse('2015-01-01')
// Fields that show a live rate is still an unchanged copy of the history rate.
const COPY_FIELDS = ['status', 'sum', 'betaltBeløp', 'løpenummer', 'faktureringsår', 'faktureringsDato']

const lower = (value) => String(value ?? '').toLowerCase()
// Same lenient read as the frontend: "1 118" and "1118,50" are numbers.
const toNumber = (value) => {
  const text = String(value ?? '').replace(/\s/g, '').replace(',', '.')
  return text === '' ? NaN : Number(text)
}
const hasAmount = (rate) => rate?.betaltBeløp !== undefined && rate?.betaltBeløp !== null && rate?.betaltBeløp !== ''
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Overført inkasso, or Betalt set through Registrer innbetaling (it has betaltBeløp).
const isRemisseRate = (rate) => lower(rate?.status) === 'overført inkasso' || (lower(rate?.status) === 'betalt' && hasAmount(rate))

// From 2015 up to now. A 2-digit year typed in a date field gives year 0026, which fails here.
const isValidDate = (value) => {
  const time = Date.parse(value)
  return !Number.isNaN(time) && time >= FIRST_DATE && time <= Date.now() + 24 * 60 * 60 * 1000
}

/**
 * Returns an error message, or null when every key and value is allowed.
 * @param {Object} data - { 'fakturaInfo.rateN.field': value }
 */
const validateHistoryRateEdit = (data) => {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return 'Ingen data å oppdatere'
  for (const [key, value] of Object.entries(data)) {
    const match = key.match(FIELD_PATTERN)
    if (!match) return `Feltet ${key} kan ikke endres i historikken`
    if (typeof value !== 'string') return `Feltet ${key} må være tekst`
    const field = match[2]
    if (field === 'status' && !STATUSES.includes(value)) return `Ugyldig status: ${value}`
    if (field === 'betaltBeløp' && !AMOUNT_PATTERN.test(value)) return `Ugyldig beløp: ${value}`
    if ((field === 'betaltDato' || field === 'sistInnbetaltDato') && value !== '' && !isValidDate(value)) return `Ugyldig dato: ${value}`
    if (field === 'editReasonCustom' && value.length > 128) return 'Forklaringen kan ikke være lengre enn 128 tegn'
  }
  return null
}

/**
 * Checks a validated edit against the stored contract.
 * expected holds status and betaltBeløp per rate as the admin saw them, to stop lost updates.
 * Returns { status, error } or { filter, changeLog }. filter makes the update fail if the rate changed in between.
 */
const planHistoryRateEdit = (document, data, expected, upn, now = new Date().toISOString()) => {
  if (!expected || typeof expected !== 'object') return { status: 400, error: 'Mangler forventede verdier (expected).' }
  const rateKeys = [...new Set(Object.keys(data).map(key => key.match(FIELD_PATTERN)[1]))]
  const filter = {}
  for (const rateKey of rateKeys) {
    const rate = document?.fakturaInfo?.[rateKey]
    const label = `Faktura ${rateKey.slice(-1)}`
    const path = (field) => `fakturaInfo.${rateKey}.${field}`
    const refuse = (error) => ({ status: 400, error: `${label}: ${error}` })
    if (!rate) return { status: 400, error: `Avtalen har ikke ${label.toLowerCase()}.` }
    for (const field of ['status', 'betaltBeløp']) {
      if (!(path(field) in expected)) return { status: 400, error: `Mangler forventet verdi for ${path(field)}` }
      if (String(expected[path(field)] ?? '') !== String(rate[field] ?? '')) return { status: 409, error: CONFLICT }
      filter[path(field)] = rate[field] ?? null // null also matches a missing field
    }
    if (!isRemisseRate(rate)) return refuse('kan ikke endres her. Bare rater med status Overført inkasso, eller som er satt til Betalt her, kan endres.')

    const status = data[path('status')]
    const amount = data[path('betaltBeløp')]
    const betaltDato = data[path('betaltDato')]
    const sistInnbetaltDato = data[path('sistInnbetaltDato')]
    const reason = String(data[path('editReasonCustom')] ?? '').trim()
    const sum = toNumber(rate.sum)
    const stored = toNumber(rate.betaltBeløp)

    if (status !== undefined && lower(status) === lower(rate.status)) return refuse('status er uendret.')
    if (amount !== undefined && sum > 0 && toNumber(amount) > sum) return refuse('innbetalt beløp er høyere enn summen.')
    // Lowering the paid amount is a correction, and needs a Forklaring.
    if (amount !== undefined && Number.isFinite(stored) && toNumber(amount) < stored && !reason) return refuse('skriv en forklaring når innbetalt beløp rettes ned.')
    // betaltDato only changes with the status, sistInnbetaltDato only with the amount.
    if (betaltDato !== undefined && status === undefined) return refuse('betaltDato kan bare endres sammen med status.')
    if (sistInnbetaltDato !== undefined && amount === undefined) return refuse('sistInnbetaltDato kan bare endres sammen med beløpet.')
    // Betalt carries betaltBeløp (marks it as set here) and a date. Back to inkasso clears the date.
    if (status === 'Betalt' && amount === undefined) return refuse('betaltBeløp må være med når status settes til Betalt.')
    if (status === 'Betalt' && !betaltDato) return refuse('betaltDato må være med når status settes til Betalt.')
    if (status === 'Overført inkasso' && betaltDato !== '') return refuse('betaltDato må tømmes når status settes tilbake til Overført inkasso.')
    // The result must add up: Betalt = the whole sum is paid, Overført inkasso = it is not.
    const newStatus = lower(status ?? rate.status)
    const newAmount = amount !== undefined ? toNumber(amount) : (Number.isFinite(stored) ? stored : 0)
    if (sum > 0 && newStatus === 'betalt' && newAmount < sum) return { status: 400, error: `${label} kan bare settes til Betalt når hele summen er betalt.` }
    if (sum > 0 && newStatus === 'overført inkasso' && newAmount >= sum) return refuse('hele summen er betalt, så status må være Betalt.')
  }
  const changeLog = Object.entries(data).map(([field, newValue]) => {
    const [, rateKey, name] = field.match(FIELD_PATTERN)
    return { field, oldValue: document.fakturaInfo[rateKey][name] ?? null, newValue, timestamp: now, changedBy: upn }
  })
  return { filter, changeLog }
}

/**
 * A newer live contract can hold a copy of these rates (applyHistoricalFakturaInfo copies them when the
 * elev signs a new contract of the same type). One update per rate, for copies that still match the
 * history rate as it was before this edit. Returns [] when the elev or type is unknown.
 */
const planInheritedUpdates = (document, data, changeLog) => {
  const fnr = document?.elevInfo?.fnr
  const kontraktType = document?.unSignedskjemaInfo?.kontraktType
  if (!fnr || fnr === 'Ukjent' || !kontraktType || kontraktType === 'Ukjent') return []
  const rateKeys = [...new Set(Object.keys(data).map(key => key.match(FIELD_PATTERN)[1]))]
  return rateKeys.map(rateKey => {
    const rate = document.fakturaInfo[rateKey]
    const prefix = `fakturaInfo.${rateKey}.`
    const filter = { 'elevInfo.fnr': fnr, 'unSignedskjemaInfo.kontraktType': { $regex: `^${escapeRegex(kontraktType)}$`, $options: 'i' } }
    for (const field of COPY_FIELDS) filter[prefix + field] = rate[field] ?? null
    const set = Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith(prefix)))
    const log = changeLog.filter(entry => entry.field.startsWith(prefix)).map(entry => ({ ...entry, source: 'historikk', historyContractId: String(document._id) }))
    return { rateKey, filter, set, changeLog: log }
  })
}

module.exports = { validateHistoryRateEdit, planHistoryRateEdit, planInheritedUpdates, isRemisseRate, CONFLICT }
