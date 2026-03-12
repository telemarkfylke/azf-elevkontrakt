const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { updateDocument, getDocuments, postProduct, deleteProduct } = require('../lib/jobs/queryMongoDB')
const { validateRoles } = require('../lib/auth/validateRoles')
const { standardFields } = require('../lib/datasources/productStandardFields')
const { ObjectId } = require('mongodb')

app.http('products', {
  methods: ['GET', 'PUT', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'products',
  handler: async (request, context) => {
    const logPrefix = 'products'
    const authorizationHeader = request.headers.get('authorization')

    // Validate the authorization header
    if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.billing-readwrite'])) {
      logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
      return { status: 403, body: 'Forbidden' }
    }

    // Check the request method
    if (request.method === 'GET') {

      // Validate the authorization header
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite', 'elevkontrakt.billing-readwrite'])) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
        return { status: 403, body: 'Forbidden' }
      }

      logger('info', [`${logPrefix} - ${request.method} request received`])
      try {
        // Fetch and return products from the database
        const products = await getDocuments({}, 'products')
        if (products.status === 404 && products.error === 'Fant ingen dokumenter') {
          logger('error', [`${logPrefix} - ${request.method}`, 'No products found in the database, create a products document first.'])
        }
        return { status: 200, jsonBody: products }
      } catch (error) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Error handling GET request', error])
        return { status: 500, body: 'Internal Server Error' }
      }
    } else if (request.method === 'PUT') {

      // Validate the authorization header
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
        return { status: 403, body: 'Forbidden' }
      }

      logger('info', [`${logPrefix} - ${request.method} request received`])
      // Handle PUT request
      try {
        const body = await request.json()
        if (!body || Object.keys(body).length === 0) {
          logger('error', [`${logPrefix} - ${request.method}`, 'No data provided in the request body'])
          return { status: 400, body: 'Bad Request: No data provided' }
        }

        if(!body.productId) {
          logger('error', [`${logPrefix} - ${request.method}`, 'No productId provided in the request body'])
          return { status: 400, body: 'Bad Request: No productId provided' }
        }

        if(!body.data) {
          logger('error', [`${logPrefix} - ${request.method}`, 'No data field provided in the request body'])
          return { status: 400, body: 'Bad Request: No data field provided' }
        }

        // Check if custom fields are being updated, if so validate that they are in the correct format.
        const customFieldsBeingUpdated = Object.keys(body.data).filter(field => !standardFields.includes(field))

        // Get current customFields for the product.
        const currentProductResult = await getDocuments({ _id: new ObjectId(body.productId) }, 'products')
        if(currentProductResult.status !== 200) {
          logger('error', [`${logPrefix} - ${request.method}`, 'Error fetching current product data from the database'])
          return { status: 500, body: 'Internal Server Error: Error fetching current product data from the database' }
        }
        const currentProduct = currentProductResult.result[0]
        const currentCustomFields = Object.keys(currentProduct).filter(key => !standardFields.includes(key))

        const customFieldsToDelete = {}
        const customFieldsToUpdate = []

        if(customFieldsBeingUpdated.length > 0) {
          customFieldsBeingUpdated.some(field => {
            const fieldValue = body.data[field]

            if(fieldValue === null && currentCustomFields.includes(field)) {
              customFieldsToDelete[field] = ""
              // Remove the custom field from the update data, we will handle the deletion of the custom field separately in the code.
              delete body.data[field]
            } else if(typeof fieldValue === 'string') {
              customFieldsToUpdate.push(field)
            } else {
              logger('error', [`${logPrefix} - ${request.method}`, `Custom field ${field} has an invalid value, must be a string or null`])
              return { status: 400, body: `Custom field ${field} has an invalid value, must be a string or null` }
            }
          })
        }

        body.$unset = customFieldsToDelete

        // Update products in the database
        const updateproducts = await updateDocument(body.productId, body, 'products')
        if (updateproducts.acknowledged !== true) {
          logger('error', [`${logPrefix} - ${request.method}`, 'Error updating products in the database'])
          return { status: 500, body: 'Internal Server Error' }
        } else {
          logger('info', [`${logPrefix} - ${request.method}`, 'products updated successfully in the database'])
          return { status: 200, jsonBody: updateproducts }
        }
      } catch (error) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Error handling PUT request', error])
        return { status: 500, body: 'Internal Server Error' }
      }
    } else if (request.method === 'POST') {

      // Validate the authorization header
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
        return { status: 403, body: 'Forbidden' }
      }

      logger('info', [`${logPrefix} - ${request.method} request received`])
      try {        
        const body = await request.json()
        if (!body || Object.keys(body).length === 0) {
          logger('error', [`${logPrefix} - ${request.method}`, 'No data provided in the request body'])
          return { status: 400, body: 'Bad Request: No data provided' }
        }
        const product = await postProduct(body)
        if (product.acknowledged !== true) {
          logger('error', [`${logPrefix} - ${request.method}`, 'Error creating product in the database'])
          return { status: 500, body: 'Internal Server Error' }
        } else {
          logger('info', [`${logPrefix} - ${request.method}`, 'Product created successfully in the database'])
          return { status: 201, jsonBody: product }
        }
      } catch (error) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Error handling POST request', error])
        return { status: 500, body: 'Internal Server Error' }
      }
    } else if (request.method === 'DELETE') {

      // Validate the authorization header
      if (!validateRoles(authorizationHeader, ['elevkontrakt.administrator-readwrite'])) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Unauthorized access attempt'])
        return { status: 403, body: 'Forbidden' }
      }

      logger('info', [`${logPrefix} - ${request.method} request received`])
      try {
        const body = await request.json()
        if (!body || !body.productId) {
          logger('error', [`${logPrefix} - ${request.method}`, 'No productId provided in the request body'])
          return { status: 400, body: 'Bad Request: No productId provided' }
        }
        const deleteResult = await deleteProduct(body.productId)
        return { status: deleteResult.status, jsonBody: deleteResult }
      } catch (error) {
        logger('error', [`${logPrefix} - ${request.method}`, 'Error handling DELETE request', error])
        return { status: 500, body: 'Internal Server Error' }
      }
    }
  }
})
