# Student Distribution by Education Program

This module provides functionality to analyze and categorize students based on their education programs (utdanningsprogram) by querying both the database and FINT API.

## Overview

The system:
1. Retrieves all student documents from the MongoDB database
2. Queries FINT for additional information about each student
3. Extracts the education program code from FINT data
4. Categorizes students based on the predefined `utdanningsprogram.js` datasource
5. Provides detailed distribution reports and statistics

## Files Created/Modified

### Core Files
- `src/lib/jobs/serverJobs/studentDistribution.js` - Main logic for student distribution analysis
- `src/lib/datasources/utdanningsprogram.js` - Education program categories datasource
- `src/functions/studentDistribution.js` - Azure Function endpoints for the API
- `src/lib/jobs/serverJobs/testStudentDistribution.js` - Test utilities

### Modified Files
- `src/functions/devTesting.js` - Added import and test options

## Usage

### 1. Via Azure Functions (Recommended)

#### Get Summary Report
```
GET /dev/studentDistribution
```
Returns a summary with statistics and top programs.

#### Get Full Data
```
GET /dev/studentDistribution?format=full
```
Returns complete data including all students and their details.

#### Download as JSON
```
GET /dev/studentDistribution?download=true&format=full
```
Downloads the complete data as a JSON file.

#### Download as CSV
```
GET /dev/studentDistribution/csv
```
Downloads the data in CSV format for Excel analysis.

### 2. Via devTesting Function

Uncomment the relevant lines in `src/functions/devTesting.js`:

```javascript
// Quick summary
const distributionResult = await getStudentDistributionByEducationProgram()
const summary = generateDistributionSummary(distributionResult)
return { status: 200, jsonBody: { summary, fullData: distributionResult } };

// OR run tests
const testResult = await testStudentDistribution()
return { status: 200, jsonBody: testResult };
```

### 3. Programmatic Usage

```javascript
const { getStudentDistributionByEducationProgram, generateDistributionSummary } = require('./src/lib/jobs/serverJobs/studentDistribution')

// Get full distribution
const result = await getStudentDistributionByEducationProgram()

// Get summary
const summary = generateDistributionSummary(result)

console.log('Total students:', result.stats.totalStudents)
console.log('Top programs:', summary.topPrograms)
```

## Data Structure

### Distribution Result
```javascript
{
  stats: {
    totalStudents: 1000,
    studentsProcessed: 1000,
    studentsWithFintData: 950,
    studentsWithoutFintData: 50,
    studentsWithEducationProgram: 920,
    studentsWithoutEducationProgram: 80,
    errors: 0
  },
  distribution: {
    "521": {
      name: "Studiespesialisering",
      students: [
        {
          documentId: "...",
          navn: "Student Name",
          fnr: "...",
          skole: "School Name",
          klasse: "3ST",
          trinn: "VG3",
          programCode: "521",
          programName: "Studiespesialisering",
          rawUtdanningsprogram: { /* FINT data */ }
        }
      ],
      count: 150
    },
    // ... other programs
    "unknown": {
      name: "Ukjent/Ikke kategorisert",
      students: [
        {
          documentId: "...",
          navn: "Student Name",
          fnr: "...",
          skole: "School Name",
          klasse: "Unknown",
          reason: "Not found in FINT or FINT error"
        }
      ],
      count: 50
    }
  },
  timestamp: "2026-02-10T10:30:00.000Z"
}
```

### Summary Result
```javascript
{
  overview: { /* stats object */ },
  topPrograms: [
    {
      code: "521",
      name: "Studiespesialisering",
      count: 150,
      percentage: "15.0"
    }
  ],
  allPrograms: [ /* all programs with counts */ ],
  emptyPrograms: [ /* programs with 0 students */ ]
}
```

## Education Program Categories

The system categorizes students into these predefined programs:

| Code | Name |
|------|------|
| 521 | Studiespesialisering |
| 522 | Bygg- og anleggsteknikk |
| 523 | Elektro og datateknologi |
| 525 | Restaurant- og matfag |
| 526 | Helse- og oppvekstfag |
| 527 | Idrettsfag |
| 528 | Teknologi- og industrifag |
| 529 | Musikk, dans og drama |
| 530 | Medier og kommunikasjon |
| 531 | Naturbruk |
| 533 | Kunst, design og arkitektur |
| 534 | Håndverk, design og produktutvikling |
| 535 | Informasjonsteknologi og medieproduksjon |
| 536 | Salg, service og reiseliv |
| 537 | Frisør, blomster, interiør og eksponeringsdesign |
| 553 | Skolelokaler i høyere yrkesfaglig utdanning |
| 554 | Høyere yrkesfaglig utdanning |
| 559 | Landslinjer |

Students that don't match any of these categories are placed in the "unknown" category with a reason explaining why.

## Error Handling

The system handles various error scenarios:

1. **Students not found in FINT** - Categorized as "unknown" with reason
2. **No active elevforhold** - Students without active school relationships
3. **Missing program data** - Students without utdanningsprogram in FINT
4. **Unknown program codes** - Codes not in the predefined datasource
5. **Database errors** - Logged and counted in error statistics

## Performance Considerations

- The function processes all students sequentially to avoid overwhelming the FINT API
- Progress is logged every student for monitoring
- Large datasets may take several minutes to process
- Consider running during off-peak hours for production environments

## Troubleshooting

### Common Issues

1. **No students found**: Check database connection and collection name
2. **FINT API errors**: Verify authentication and API endpoints in config
3. **Program code extraction fails**: Check the `extractEducationProgramCode` function logic
4. **Memory issues**: Process in batches for very large datasets

### Debugging

Enable the test in `devTesting.js` to run the code extraction tests:
```javascript
const testResult = await testStudentDistribution()
return { status: 200, jsonBody: testResult };
```

This will test the program code extraction logic and provide a quick overview of the distribution.

## Future Enhancements

- Add filtering by school or date range
- Implement caching for FINT responses
- Add scheduled reports via timer functions
- Export to Excel with charts and formatting
- Add email notifications for completed analyses