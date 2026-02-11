const { logger } = require('@vtfk/logger')
const { getDocuments } = require('../queryMongoDB')
const { student } = require('../queryFINT')
const { utdanningsprogram } = require('../../datasources/utdanningsprogram')

/**
 * Get all students from the database and categorize them by their education program (utdanningsprogram)
 * 
 * 1. Retrieves all student documents from the database
 * 2. Queries FINT for additional information about each student
 * 3. Extracts the education program code from FINT data
 * 4. Categorizes students based on the utdanningsprogram datasource
 * 5. Returns a distribution report showing students grouped by education program
 */
const getStudentDistributionByEducationProgram = async () => {
  const loggerPrefix = 'getStudentDistributionByEducationProgram'
  logger('info', [loggerPrefix, 'Starting student distribution analysis'])

  const stats = {
    totalStudents: 0,
    studentsProcessed: 0,
    studentsWithFintData: 0,
    studentsWithoutFintData: 0,
    studentsWithEducationProgram: 0,
    studentsWithoutEducationProgram: 0,
    errors: 0
  }

  const distribution = {}
  utdanningsprogram.forEach(program => {
    distribution[program.code] = {
      name: program.name,
      students: [],
      count: 0
    }
  })

  distribution.unknown = {
    name: 'Ukjent/Ikke kategorisert',
    students: [],
    count: 0
  }

  try {
    logger('info', [loggerPrefix, 'Fetching all student documents from database'])
    const documents = await getDocuments({}, 'regular')
    
    // documents.result.splice(10) // Limit to 10 documents for testing

    if (!documents.result || documents.result.length === 0) {
      logger('info', [loggerPrefix, 'No student documents found in database'])
      return {
        stats,
        distribution,
        message: 'No students found in database'
      }
    }

    stats.totalStudents = documents.result.length
    logger('info', [loggerPrefix, `Found ${stats.totalStudents} student documents`])

    for (const doc of documents.result) {
      stats.studentsProcessed++
      
      try {
        const fnr = doc.elevInfo?.fnr
        if (!fnr) {
          logger('warn', [loggerPrefix, `Document ${doc._id} missing fnr, skipping`])
          continue
        }

        logger('info', [loggerPrefix, `Processing student ${stats.studentsProcessed}/${stats.totalStudents}: ${doc.elevInfo?.navn || 'Unknown name'}`])
        const fintData = await student(fnr, false, false)
        
        if (fintData.status === 404 || fintData.status === 500) {
          logger('warn', [loggerPrefix, `Student ${fnr} not found in FINT or error occurred`])
          stats.studentsWithoutFintData++
          
          distribution.unknown.students.push({
            documentId: doc._id,
            navn: doc.elevInfo?.navn || 'Unknown',
            fnr: fnr,
            skole: doc.elevInfo?.skole || 'Unknown',
            klasse: doc.elevInfo?.klasse || 'Unknown',
            reason: 'Not found in FINT or FINT error'
          })
          continue
        }

        stats.studentsWithFintData++

        const activeElevforhold = fintData.elevforhold?.filter(forhold => forhold.aktiv === true) || []
        
        if (activeElevforhold.length === 0) {
          logger('warn', [loggerPrefix, `No active elevforhold found for student ${fnr}`])
          stats.studentsWithoutEducationProgram++
          
          distribution.unknown.students.push({
            documentId: doc._id,
            navn: doc.elevInfo?.navn || 'Unknown',
            fnr: fnr,
            skole: doc.elevInfo?.skole || 'Unknown',
            klasse: doc.elevInfo?.klasse || 'Unknown',
            reason: 'No active elevforhold'
          })
          continue
        }

        let primaryElevforhold = activeElevforhold.find(forhold => 
          forhold.kategori?.navn?.toLowerCase() !== 'privatist' && 
          forhold.skole?.skolenummer !== '70036'
        ) || activeElevforhold[0]

        const programomrademedlemskap = primaryElevforhold.programomrademedlemskap
        if (!programomrademedlemskap || programomrademedlemskap.length === 0) {
          logger('warn', [loggerPrefix, `No programomrademedlemskap found for student ${fnr}`])
          stats.studentsWithoutEducationProgram++
          
          distribution.unknown.students.push({
            documentId: doc._id,
            navn: doc.elevInfo?.navn || 'Unknown',
            fnr: fnr,
            skole: primaryElevforhold.skole?.navn || doc.elevInfo?.skole || 'Unknown',
            klasse: doc.elevInfo?.klasse || 'Unknown',
            reason: 'No programomrademedlemskap in elevforhold'
          })
          continue
        }

        const activeProgramomrade = programomrademedlemskap.find(program => program.aktiv === true) || programomrademedlemskap[0]
        
        if (!activeProgramomrade || !activeProgramomrade.utdanningsprogram || activeProgramomrade.utdanningsprogram.length === 0) {
          logger('warn', [loggerPrefix, `No utdanningsprogram found in programomrademedlemskap for student ${fnr}`])
          stats.studentsWithoutEducationProgram++
          
          distribution.unknown.students.push({
            documentId: doc._id,
            navn: doc.elevInfo?.navn || 'Unknown',
            fnr: fnr,
            skole: primaryElevforhold.skole?.navn || doc.elevInfo?.skole || 'Unknown',
            klasse: doc.elevInfo?.klasse || 'Unknown',
            reason: 'No utdanningsprogram in programomrademedlemskap'
          })
          continue
        }

        const utdanningsprogramData = activeProgramomrade.utdanningsprogram[0]
        
        const matchResult = findMatchingProgram(utdanningsprogramData, utdanningsprogram)
        
        if (!matchResult.found) {
          logger('warn', [loggerPrefix, `Could not match program for student ${fnr}, utdanningsprogram: ${JSON.stringify(utdanningsprogramData)}`])
          stats.studentsWithoutEducationProgram++
          
          distribution.unknown.students.push({
            documentId: doc._id,
            navn: doc.elevInfo?.navn || 'Unknown',
            fnr: fnr,
            skole: primaryElevforhold.skole?.navn || doc.elevInfo?.skole || 'Unknown',
            klasse: doc.elevInfo?.klasse || 'Unknown',
            reason: `Could not match program: ${utdanningsprogramData.navn || utdanningsprogramData.systemId?.identifikatorverdi}`,
            rawUtdanningsprogram: utdanningsprogramData,
            rawProgramomrademedlemskap: activeProgramomrade
          })
          continue
        }

        stats.studentsWithEducationProgram++

        const category = distribution[matchResult.code]
        
        const studentInfo = {
          documentId: doc._id,
          navn: doc.elevInfo?.navn || 'Unknown',
          fnr: fnr,
          skole: primaryElevforhold.skole?.navn || doc.elevInfo?.skole || 'Unknown',
          klasse: doc.elevInfo?.klasse || 'Unknown',
          trinn: doc.elevInfo?.trinn || 'Unknown',
          programCode: matchResult.code,
          programName: utdanningsprogramData.navn,
          matchedBy: matchResult.matchedBy,
          programomradeName: activeProgramomrade.navn,
          rawUtdanningsprogram: utdanningsprogramData,
          rawProgramomrademedlemskap: activeProgramomrade
        }

        category.students.push(studentInfo)

      } catch (error) {
        logger('error', [loggerPrefix, `Error processing student document ${doc._id}:`, error])
        stats.errors++
      }
    }

    Object.keys(distribution).forEach(code => {
      distribution[code].count = distribution[code].students.length
    })

    logger('info', [loggerPrefix, 'Student distribution analysis completed', stats])

    return {
      stats,
      distribution,
      timestamp: new Date().toISOString()
    }

  } catch (error) {
    logger('error', [loggerPrefix, 'Error during student distribution analysis:', error])
    throw error
  }
}

/**
 * Find matching program from the utdanningsprogram datasource
 * @param {Object} utdanningsprogramData - The FINT utdanningsprogram data
 * @param {Array} utdanningsprogramDatasource - The datasource array
 * @returns {Object} - {found: boolean, code: string, matchedBy: string}
 */
const findMatchingProgram = (utdanningsprogramData, utdanningsprogramDatasource) => {
  if (!utdanningsprogramData) {
    return { found: false, code: null, matchedBy: null }
  }

  const programName = utdanningsprogramData.navn
//   const systemId = utdanningsprogramData.systemId?.identifikatorverdi

  if (programName) {
    const nameMatch = utdanningsprogramDatasource.find(program => 
      program.name.toLowerCase() === programName.toLowerCase()
    )
    if (nameMatch) {
      return { found: true, code: nameMatch.code, matchedBy: 'exact_name' }
    }
  }

  if (programName) {
    const partialNameMatch = utdanningsprogramDatasource.find(program => 
      program.name.toLowerCase().includes(programName.toLowerCase()) ||
      programName.toLowerCase().includes(program.name.toLowerCase())
    )
    if (partialNameMatch) {
      return { found: true, code: partialNameMatch.code, matchedBy: 'partial_name' }
    }
  }

// This is useless for now, hopefully they will add support for this later 
//   if (systemId) {
//     const codeMatch = systemId.toString().match(/(\d{3})/)
//     if (codeMatch) {
//       const extractedCode = codeMatch[1]
//       const foundProgram = utdanningsprogramDatasource.find(program => program.code === extractedCode)
//       if (foundProgram) {
//         return { found: true, code: extractedCode, matchedBy: 'system_id_code' }
//       }
//     }
//   }

  return { found: false, code: null, matchedBy: null }
}

/**
 * Generate a summary report of the student distribution
 * @param {Object} distributionResult - Result from getStudentDistributionByEducationProgram
 * @returns {Object} - Summary report
 */
const generateDistributionSummary = (distributionResult) => {
  const { stats, distribution } = distributionResult
  
  // Sort categories by student count (descending)
  const sortedCategories = Object.entries(distribution)
    .filter(([code, data]) => data.count > 0)
    .sort(([, a], [, b]) => b.count - a.count)
  
  const summary = {
    overview: stats,
    topPrograms: sortedCategories.slice(0, 10).map(([code, data]) => ({
      code,
      name: data.name,
      count: data.count,
      percentage: ((data.count / stats.totalStudents) * 100).toFixed(1)
    })),
    allPrograms: sortedCategories.map(([code, data]) => ({
      code,
      name: data.name,
      count: data.count,
      percentage: ((data.count / stats.totalStudents) * 100).toFixed(1)
    })),
    emptyPrograms: Object.entries(distribution)
      .filter(([code, data]) => data.count === 0)
      .map(([code, data]) => ({
        code,
        name: data.name
      }))
  }
  
  return summary
}

module.exports = {
  getStudentDistributionByEducationProgram,
  generateDistributionSummary,
  findMatchingProgram
}
