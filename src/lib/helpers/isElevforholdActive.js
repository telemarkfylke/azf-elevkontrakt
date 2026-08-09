const { getSchoolyear } = require('./getSchoolyear')

// FINT's "aktiv" flag only flips to true once gyldighetsperiode.start has passed,
// but a student's elevforhold for the upcoming school year exists in FINT well
// before that (e.g. during summer). We instead check if gyldighetsperiode overlaps
// the current school year window, using the same cutover as getSchoolyear().
const isElevforholdActive = (forhold) => {
  if (!forhold?.gyldighetsperiode?.start || !forhold?.gyldighetsperiode?.slutt) return false

  const now = new Date()
  const currentSchoolYearStart = Number(getSchoolyear().split('-')[0])
  const schoolYearStart = new Date(Date.UTC(currentSchoolYearStart, 7, 1)) // 1. august
  const schoolYearEnd = new Date(Date.UTC(currentSchoolYearStart + 1, 6, 31, 23, 59, 59, 999)) // 31. juli neste år

  const forholdStart = new Date(forhold.gyldighetsperiode.start)
  const forholdSlutt = new Date(forhold.gyldighetsperiode.slutt)
  const overlapsCurrentSchoolYear = forholdStart <= schoolYearEnd && forholdSlutt >= schoolYearStart
  if (!overlapsCurrentSchoolYear) return false

  if (forhold.avbruddsdato && new Date(forhold.avbruddsdato) <= now) return false

  return true
}

module.exports = {
  isElevforholdActive
}
