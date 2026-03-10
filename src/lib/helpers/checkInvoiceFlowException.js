/**
 * 
 * @param {String} fnr | The student's personal identification number (fødselsnummer)
 * @param {Object} exceptionsFromInvoiceFlow  | The exceptions from the invoice flow, which includes a list of students with exceptions
 * @returns {Boolean} | True if the student has an exception in the invoice flow, false otherwise
 * 
 * This function checks if a student has an exception in the invoice flow based on their personal identification number (fnr) and the list of exceptions. If the student is found in the exceptions list, it returns true, indicating that there is an exception for this student in the invoice flow. If the student is not found in the exceptions list, it returns false, indicating that there are no exceptions for this student in the invoice flow.
 */
const hasInvoiceFlowException = (fnr, exceptionsFromInvoiceFlow) => {
    const exception = exceptionsFromInvoiceFlow.students.find(entry => entry.fnr === fnr)
    return !!exception
}

module.exports = {
    hasInvoiceFlowException
}