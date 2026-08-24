// Norwegian fnr/d-numbers are 11 digits: DDMMYY (birthdate) + NNNNN (personal number).
// Keep the birthdate part visible, mask the personal number part.
const FNR_PATTERN = /\d{11}/g

const maskFnr = (fnr) => {
  if (!fnr || typeof fnr !== 'string') return 'Ukjent'
  if (fnr.length <= 6) return '*'.repeat(fnr.length)
  return `${fnr.slice(0, 6)}${'*'.repeat(fnr.length - 6)}`
}

const redactFnrInText = (text) => {
  if (!text || typeof text !== 'string') return text
  return text.replace(FNR_PATTERN, match => maskFnr(match))
}

// Builds a safe object to pass to logger() instead of a raw axios/generic error.
// Never includes error.config.headers (drops Authorization bearer tokens too),
// and redacts any fnr-shaped digit runs found in the url/request/response data,
// since we don't know in advance where in these strings an fnr might be echoed back.
const sanitizeErrorForLogging = (error) => {
  if (!error) return { message: 'Unknown error' }
  const sanitized = {
    message: redactFnrInText(error.message)
  }
  if (error.response?.status) sanitized.status = error.response.status
  if (error.config?.url) sanitized.url = redactFnrInText(error.config.url)
  if (error.config?.data) sanitized.requestData = redactFnrInText(typeof error.config.data === 'string' ? error.config.data : JSON.stringify(error.config.data))
  if (error.response?.data) sanitized.responseData = redactFnrInText(typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
  return sanitized
}

module.exports = { maskFnr, redactFnrInText, sanitizeErrorForLogging }
