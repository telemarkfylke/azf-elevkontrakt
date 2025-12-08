const { logger } = require('@vtfk/logger')
const { promises: fs } = require('fs')

const readAndParseCSV = async (filePath) => {
  const loggerPrefix = 'readAndParseCSV'
  logger('info', [loggerPrefix, `Reading and parsing CSV file from ${filePath}`])
  // Get the CSV file path
  const csvFilePath = filePath
  // Read the CSV file and parse it
  let csvRows = []
  try {
    const raw = await fs.readFile(csvFilePath, 'utf-8')
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    const lines = text.split('\n').filter(Boolean)
    if (lines.length > 0) {
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

      const headers = parseLine(headerLine)
      csvRows = lines.slice(1).map((line) => {
        const cols = parseLine(line)
        const obj = {}
        headers.forEach((h, i) => {
          obj[h] = cols[i] ?? ''
        })
        return obj
      })
      logger('info', [loggerPrefix, `Parsed ${csvRows.length} rows from CSV - ${csvFilePath}`])
    } else {
      logger('info', [loggerPrefix, 'CSV file is empty'])
    }
  } catch (err) {
    logger('error', [loggerPrefix, 'Failed to read/parse CSV file', err && err.message ? err.message : err])
    csvRows = []
  }

  return csvRows
}

module.exports = {
  readAndParseCSV
}
