const getSchoolyear = () => {
    const date = new Date()
    const month = date.getMonth()
    const year = date.getFullYear()
    if (month < 6) {
        return `${year - 1}-${year}`
    }
    return `${year}-${year + 1}`
}

module.exports = {
    getSchoolyear
}