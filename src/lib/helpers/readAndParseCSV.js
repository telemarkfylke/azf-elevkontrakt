const { logger } = require('@vtfk/logger')
const { promises: fs } = require('fs')

/**
 * Parses CSV text into an array of row objects keyed by the header line.
 *
 * Split out of readAndParseCSV so callers that already hold the text - an uploaded file, say
 * (bulkInvoiceFromFile.js) - can reuse the delimiter and quote handling instead of growing a second
 * CSV parser next to this one.
 *
 * The delimiter is detected from the header line: ';' when it has more semicolons than commas, else
 * ','. Norwegian Excel writes ';'.
 *
 * Header keys have the UTF-8 BOM stripped. Excel puts one in front of the first header, which
 * otherwise turns column 'fnr' into '﻿fnr' and makes every lookup on it miss. Callers that
 * strip it themselves (miscCleanUpJobs.js, markCherwellPcReturns) keep working - their strip
 * becomes a no-op.
 *
 * @param {String} text - raw CSV text
 * @param {String} [logContext] - included in the log line, so the caller can say where the text came from
 * @returns {Array<Object>} - one object per data row; missing columns are ''. Empty input gives []
 */
const parseCSVString = (text, logContext = 'text') => {
  const loggerPrefix = 'parseCSVString'
  if (typeof text !== 'string') {
    logger('error', [loggerPrefix, `Expected a string, got ${typeof text} - ${logContext}`])
    return []
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const lines = normalized.split('\n').filter(Boolean)
  if (lines.length === 0) {
    logger('info', [loggerPrefix, `CSV is empty - ${logContext}`])
    return []
  }

  const headerLine = lines[0]
  const delimiter =
    (headerLine.split(';').length - 1) > (headerLine.split(',').length - 1) ? ';' : ','

  const parseLine = (line) => {
    const out = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur)
    return out.map((v) => v.trim())
  }

  const headers = parseLine(headerLine).map((header) => header.replace(/^﻿/, ''))
  const csvRows = lines.slice(1).map((line) => {
    const cols = parseLine(line)
    const obj = {}
    headers.forEach((h, i) => {
      obj[h] = cols[i] ?? ''
    })
    return obj
  })
  logger('info', [loggerPrefix, `Parsed ${csvRows.length} rows from CSV - ${logContext}`])
  return csvRows
}

/**
 * Reads a CSV file from disk and parses it. Never throws - on any read or parse failure it logs and
 * returns [], so callers must treat an empty array as "abort", not "no rows".
 * @param {String} filePath
 * @returns {Promise<Array<Object>>}
 */
const readAndParseCSV = async (filePath) => {
  const loggerPrefix = 'readAndParseCSV'
  logger('info', [loggerPrefix, `Reading and parsing CSV file from ${filePath}`])
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return parseCSVString(raw, filePath)
  } catch (err) {
    logger('error', [loggerPrefix, 'Failed to read/parse CSV file', err && err.message ? err.message : err])
    return []
  }
}

module.exports = {
  readAndParseCSV,
  parseCSVString
}
