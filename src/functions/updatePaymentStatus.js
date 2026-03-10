const { app } = require('@azure/functions')
const { updatePaymentStatus } = require('../lib/jobs/updatePaymentStatus')
const { logger } = require('@vtfk/logger')

// Legger det som rute nå for test. bør være timetrigger i prod
app.http('updatePaymentStatusDev', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dev/updatePaymentStatus',
  handler: async (request, context) => {
    const upn = request.params.upn
    try {
      const response = await updatePaymentStatus('invoices', 'extraInvoice')
      return { status: 200, jsonBody: response }
    } catch (error) {
      logger('error', ['updatePaymentStatus', error])
      return { status: 400, jsonBody: error.message }
    }
  }
})

app.timer('updatePaymentStatus', {
  // Once every day at 05:00 AM
  schedule: '0 5 * * *',
  handler: async (myTimer, context) => {
    try {
      logger('info', ['updatePaymentStatus', 'Timer trigger function started'])
      const report = await updatePaymentStatus('regular', undefined)
      logger('info', ['updatePaymentStatus', 'Timer trigger function completed, report:', report])
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['updatePaymentStatus', error])
      return { status: 500, jsonBody: { error: 'Failed to update payment status' } }
    }
  }
})

app.timer('updatePaymentStatusPCNotDelivered', {
  // Once every day at 04:00 AM
  schedule: '0 4 * * *',
  handler: async (myTimer, context) => {
    try {
      logger('info', ['updatePaymentStatus', 'Timer trigger function started'])
      const report = await updatePaymentStatus('pcIkkeInnlevert', undefined)
      logger('info', ['updatePaymentStatus', 'Timer trigger function completed, report:', report])
      return { status: 200, jsonBody: report }
    } catch (error) {
      logger('error', ['updatePaymentStatus', error])
      return { status: 500, jsonBody: { error: 'Failed to update payment status' } }
    }
  }
})


// app.timer('updatePaymentStatusExtraInvoice', {
//   // Once every day at 04:15 AM
//   schedule: '0 15 4 * * *',
//   handler: async (myTimer, context) => {
//     try {
//       logger('info', ['updatePaymentStatus', 'Timer trigger function started'])
//       const report = await updatePaymentStatus('invoices', 'extraInvoice')
//       logger('info', ['updatePaymentStatus', 'Timer trigger function completed, report:', report])
//       return { status: 200, jsonBody: report }
//     } catch (error) {
//       logger('error', ['updatePaymentStatus', error])
//       return { status: 500, jsonBody: { error: 'Failed to update payment status' } }
//     }
//   }
// })

// app.timer('updatePaymentStatusBuyOut', {
//   // Once every day at 04:30 AM
//   schedule: '0 30 4 * * *',
//   handler: async (myTimer, context) => {
//     try {
//       logger('info', ['updatePaymentStatus', 'Timer trigger function started'])
//       const report = await updatePaymentStatus('invoices', 'buyOut')
//       logger('info', ['updatePaymentStatus', 'Timer trigger function completed, report:', report])
//       return { status: 200, jsonBody: report }
//     } catch (error) {
//       logger('error', ['updatePaymentStatus', error])
//       return { status: 500, jsonBody: { error: 'Failed to update payment status' } }
//     }
//   }
// })