const { app } = require('@azure/functions')
const { getStudentDistributionByEducationProgram, generateDistributionSummary } = require('../lib/jobs/serverJobs/studentDistribution')
const { logger } = require('@vtfk/logger')

app.http('studentDistribution', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/studentDistribution',
  handler: async (request, context) => {
    try {
      // Get query parameters
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'summary' // 'summary' or 'full'
      const download = url.searchParams.get('download') === 'true'

      // Run the student distribution analysis
      const distributionResult = await getStudentDistributionByEducationProgram()
      
      let responseData
      if (format === 'full') {
        responseData = distributionResult
      } else {
        // Return summary by default
        responseData = {
          summary: generateDistributionSummary(distributionResult),
          stats: distributionResult.stats,
          timestamp: distributionResult.timestamp
        }
      }

      // If download is requested, format as JSON for download
      if (download) {
        const filename = `student-distribution-${new Date().toISOString().split('T')[0]}.json`
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`
          },
          body: JSON.stringify(responseData, null, 2)
        }
      }

      return {
        status: 200,
        jsonBody: responseData
      }
      
    } catch (error) {
      logger('error', ['studentDistribution', 'Error generating report:', error])
      return {
        status: 500,
        jsonBody: {
          error: 'Failed to generate student distribution report',
          message: error.message
        }
      }
    }
  }
})

app.http('studentDistributionCsv', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/studentDistribution/csv',
  handler: async (request, context) => {
    try {
      // Run the student distribution analysis
      const distributionResult = await getStudentDistributionByEducationProgram()
      
      // Convert to CSV format
      const csvData = convertDistributionToCsv(distributionResult)
      
      const filename = `student-distribution-${new Date().toISOString().split('T')[0]}.csv`
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filename}"`
        },
        body: csvData
      }
      
    } catch (error) {
      logger('error', ['studentDistributionCsv', 'Error generating CSV:', error])
      return {
        status: 500,
        jsonBody: {
          error: 'Failed to generate student distribution CSV',
          message: error.message
        }
      }
    }
  }
})

/**
 * Convert distribution result to CSV format
 */
 const convertDistributionToCsv = (distributionResult) => {
  const { distribution } = distributionResult
  
  //CSV header
  let csv = 'Program Code,Program Name,Student Count,Student Name,FNR,School,Class,Trinn,Document ID,Reason\n'
  
  Object.entries(distribution).forEach(([code, data]) => {
    if (data.students.length === 0) {
      // Row for utdanningsprogram with no students
      csv += `"${code}","${data.name}",0,,,,,,,\n`
    } else {
      // Students row for utdanningsprogram
      data.students.forEach(student => {
        csv += `"${code}","${data.name}",${data.count},"${student.navn}","${student.fnr}","${student.skole}","${student.klasse || ''}","${student.trinn || ''}","${student.documentId}","${student.reason || ''}"\n`
      })
    }
  })
  
  return csv
}