/**
 * Returns the correct price for a student based on their class and any exceptions.
 * @param {String} fnr - The student's personal identification number.
 * @param {String} studentClass - The class the student belongs to.
 * @param {Object} prices - The price settings.
 * @param {Object} exceptionsFromRegularPrices - The exceptions from regular prices.
 * @returns {String} - The correct price for the student
 */
const returnCorrectPriceForStudent = (fnr, studentClass, prices, exceptionsFromRegularPrices) => {
// If there are no exceptions found in the settings, return the regular price
if (exceptionsFromRegularPrices.students.length === 0 && exceptionsFromRegularPrices.classes.length === 0) {
    return prices.regularPrice
}

if (exceptionsFromRegularPrices.students.length > 0) {
    // Check if the student is in the exceptions list
    const studentException = exceptionsFromRegularPrices.students.find(student => student.fnr === fnr)
    if (studentException) {
    return prices.reducedPrice
    }
}

if (exceptionsFromRegularPrices.classes.length > 0) {
    // Check if the student is in the class exceptions list
    const classException = exceptionsFromRegularPrices.classes.find(cls => cls.className === studentClass)
    if (classException) {
    return prices.reducedPrice
    }
}

// If no exceptions found on the student, return regular price
return prices.regularPrice
}

module.exports = {
    returnCorrectPriceForStudent
}