(async () => {
    require('dotenv').config();
    const { logger } = require('@vtfk/logger');
    const { updateStudentPCStatus } = require('./updateStudentPCStatus.js');
    const fs = require('fs').promises;

    logger('info', ['Starting updateStudentPCStatus job']);

    logger('info', ['Updating student PC status for utlevering']);

    await updateStudentPCStatus('utlevering')
    logger('info', ['Finished updateStudentPCStatus job for utlevering']);
})()