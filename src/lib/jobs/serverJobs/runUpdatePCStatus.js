(async () => {
    require('dotenv').config();
    const { logger } = require('@vtfk/logger');
    const { updateStudentPCStatus } = require('./updateStudentPCStatus.js');

    logger('info', ['Starting updateStudentPCStatus job']);

    logger('info', ['Updating student PC status for utlevering']);
    const statusUpdateUtlevering = await updateStudentPCStatus('utlevering')
    logger('info', [`Finished updateStudentPCStatus job for utlevering. Number of utlevert: ${statusUpdateUtlevering.updateCount}`]);

    // logger('info', ["Updating student PC status fir innlevering"])
    // const statusUpdateInnlevering = await updateStudentPCStatus('innlevering')
    // logger('info', [`Finished updateStudentPCStatus job for innlevering. Number of innlevert: ${statusUpdateInnlevering.updateCount}`])
    return true
})()