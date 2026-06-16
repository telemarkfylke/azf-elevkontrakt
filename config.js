module.exports = {
  appReg: {
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    scope: process.env.AZURE_SCOPE,
    grantType: process.env.AZURE_GRANT_TYPE || 'client_credentials'
  },
  xledger: {
    url: process.env.XLEDGER_URL,
    scope: process.env.XLEDGER_SCOPE
  },
  fint: {
    url: process.env.FINT_URL,
    scope: process.env.FINT_SCOPE,
    endPointEmployee: process.env.FINT_ENDPOINT_EMPLOYEE,
    endPointStudent: process.env.FINT_ENDPOINT_STUDENT,
    queryTypeSSN: process.env.FINT_QUERY_TYPE_SSN,
    queryTypeUPN: process.env.FINT_QUERY_TYPE_UPN,
    queryTypeOrgId: process.env.FINT_QUERY_TYPE_ORGID,
    endPointSchoolInfo: process.env.FINT_ENDPOINT_ORG
  },
  freg: {
    url: process.env.FREG_URL,
    scope: process.env.FREG_SCOPE,
    endPoint: process.env.FREG_ENDPOINT_PERSON
  },
  krr: {
    url: process.env.KRR_URL,
    key: process.env.KRR_X_FUNCTIONS_KEY
  },
  mongoDB: {
    connectionString: process.env.MONGODB_CONNECTION_STRING,
    dbName: process.env.MONGODB_DB_NAME,
    dbnameXledgerSerialNumbers: process.env.MONGODB_DB_NAME_XLEDGER_SERIALNUMBERS,
    errorCollection: process.env.MONGODB_ERROR_COLLECTION,
    contractsCollection: process.env.MONGODB_CONTRACTS_COLLECTION,
    errorMockCollection: process.env.MONGODB_ERROR_MOCK_COLLECTION,
    contractsMockCollection: process.env.MONGODB_CONTRACTS_MOCK_COLLECTION,
    deletedCollection: process.env.MONGODB_DELETED_COLLECTION,
    deletedMockCollection: process.env.MONGODB_DELETED_MOCK_COLLECTION,
    historicCollection: process.env.MONGODB_HISTORY_COLLECTION,
    preImportDigitrollCollection: process.env.MONGODB_PRE_IMPORT_DIGITROLL_COLLECTION,
    duplicatesCollection: process.env.MONGODB_DUPLICATES_COLLECTION,
    historicPcNotDeliveredCollection: process.env.MONGODB_HISTORIC_PC_NOT_DELIVERED_COLLECTION,
    serialnumberCollection: process.env.MONGODB_LOPENUMMER_COLLECTION,
    settingsCollection: process.env.MONGODB_SETTINGS_COLLECTION,
    productsCollection: process.env.MONGODB_PRODUCTS_COLLECTION,
    invoiceCollection: process.env.MONGODB_INVOICE_COLLECTION
  },
  pureservice: {
    url: process.env.PUS_URL,
    key: process.env.PUS_KEY
  },
  archive: {
    url: process.env.ARCHIVE_URL,
    scope: process.env.ARCHIVE_SCOPE
  },
  teams: {
    webhook: process.env.TEAMS_WEBHOOK_URL
  },
  email: {
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO ? process.env.EMAIL_TO.split(',') : [],
    xFunctionsKey: process.env.EMAIL_API_KEY,
    url: process.env.EMAIL_API_URL
  },
  changeStream: {
    storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    tokenBlobContainer: process.env.CHANGE_STREAM_TOKEN_BLOB_CONTAINER || `change-stream-state-${process.env.NODE_ENV || 'dev'}`,
    tokenBlobName: process.env.CHANGE_STREAM_TOKEN_BLOB_NAME || `resume-token-${process.env.NODE_ENV || 'dev'}.json`,
    dlqName: process.env.CHANGE_STREAM_DLQ_NAME || `change-stream-dlq-${process.env.NODE_ENV || 'dev'}`,
    listeningWindowMs: 27 * 60 * 1000,
    // JSON array of { collection, fields, includeInserts, includeDeletes }.
    // Use dot notation for nested fields ("student.firstName").
    // Caveat: $set on a parent object ("student") records "student" as the key, not child paths —
    // add the parent key to fields too if that pattern occurs in your write path.
    watchCollections: JSON.parse(process.env.CHANGE_STREAM_WATCH_COLLECTIONS || '[]')
  }
}
