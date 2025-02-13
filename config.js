module.exports = {
    appReg: {
        tenantId: process.env.AZURE_TENANT_ID,
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        scope: process.env.AZURE_SCOPE,
        grantType: process.env.AZURE_GRANT_TYPE || 'client_credentials',
    },
    fint: {
        url: process.env.FINT_URL,
        scope: process.env.FINT_SCOPE,
        endPointEmployee: process.env.FINT_ENDPOINT_EMPLOYEE,
        endPointStudent: process.env.FINT_ENDPOINT_STUDENT,
        queryTypeSSN: process.env.FINT_QUERY_TYPE_SSN,
        queryTypeUPN: process.env.FINT_QUERY_TYPE_UPN,
    },
    freg: {
        url: process.env.FREG_URL,
        scope: process.env.FREG_SCOPE,
        endPoint: process.env.FREG_ENDPOINT_PERSON,
    }
}