const { logger } = require('@vtfk/logger')
const { classifyIdentifier } = require('../jobs/classifyIdentifier')
const { detectIdentifierType } = require('../helpers/identifier')
const { maskFnr } = require('../helpers/maskFnr')

/**
 * Three things on a manual contract are administrator-only:
 *
 *   1. an elev with a fiktivt fødselsnummer
 *   2. an organisasjon as the ansvarlig (the party that gets invoiced)
 *   3. a school chosen by hand, which only happens when FINT has no active elevforhold
 *
 * Every other manual contract stays open to itservicedesk and skoleadministrator, unchanged.
 *
 * MUST be called before archiveDocument. A refusal after archiving would leave a document in P360
 * for a contract that was never created, and no job can tell that one apart from a real contract.
 *
 * Nothing the client sent is trusted for (1) and (3): both come from classifyIdentifier, the same
 * function the form's own lookup used, so the answer here cannot be steered by editing the payload.
 * (2) is necessarily read from the payload - it IS the instruction to invoice an organisation - so
 * both the declared type and the shape of the identifier are checked.
 *
 * @param {Object} contract - the posted manual contract body
 * @param {Boolean} isAdmin - caller holds elevkontrakt.administrator-readwrite
 * @param {Object} [deps]
 * @returns {Promise<Object|null>} - null when allowed, else { status, error, reason } to return
 */
const assertManualContractAllowed = async (contract, isAdmin, deps = {}) => {
  const { classifyIdentifier: _classifyIdentifier = classifyIdentifier } = deps
  const logPrefix = 'assertManualContractAllowed'

  // Administrators may do all three, so they never pay for the lookup below.
  if (isAdmin) return null

  const refuse = (error) => {
    logger('warn', [logPrefix, 'Avviste manuell kontrakt som krever administrator', error])
    return { status: 403, error, reason: 'requires-admin' }
  }

  // Read from the payload because it is the instruction itself. The second arm matters: leaving
  // ansvarligType out would otherwise send a 9-digit orgnr down the person path unchallenged.
  const declaresOrg = contract?.ansvarligType === 'organisasjon'
  const looksLikeOrg = detectIdentifierType(contract?.foresattFnr) === 'orgnr'
  if (declaresOrg || looksLikeOrg) {
    return refuse('Bare en administrator kan opprette en avtale der en virksomhet er ansvarlig. Ta kontakt med en administrator.')
  }

  if (!contract?.fnr) {
    // Nothing to classify. postManualContract refuses this anyway; saying so here keeps the
    // refusal about the missing number rather than about permissions.
    return { status: 400, error: 'Mangler fødselsnummer på eleven', reason: 'invalid-contract' }
  }

  let classification
  try {
    classification = await _classifyIdentifier(contract.fnr)
  } catch (error) {
    logger('error', [logPrefix, 'Klarte ikke klassifisere eleven', error.message])
    return { status: 502, error: 'Kunne ikke verifisere eleven. Prøv igjen.', reason: 'lookup-failed' }
  }

  /**
   * A failed classification is not a permission problem, and must never be reported as one - an
   * unreachable archive would then tell a non-admin they lack access to their own ordinary student.
   * Hand back the classification's own reason; the contract would have failed in archiveDocument
   * regardless.
   */
  if (!classification?.ok) {
    const statusByReason = { 'invalid-format': 400, 'not-found': 404, 'no-case-number': 409, 'lookup-failed': 502 }
    return {
      status: statusByReason[classification?.reason] || 400,
      error: classification?.error || 'Kunne ikke verifisere eleven',
      reason: classification?.reason || 'lookup-failed'
    }
  }

  if (classification.fnrType === 'fiktiv') {
    logger('info', [logPrefix, `Fiktivt fnr ${maskFnr(contract.fnr)} avvist for ikke-administrator`])
    return refuse('Bare en administrator kan opprette avtale for en elev med fiktivt fødselsnummer. Ta kontakt med en administrator og oppgi elevens nummer.')
  }

  /**
   * No school from FINT means no active elevforhold, which means the school on this contract can
   * only have come from the manual picker. Deliberately derived rather than flagged by the client:
   * a flag could simply be omitted.
   */
  if (!classification.school?.orgNr) {
    return refuse('Eleven har ingen aktivt elevforhold i VIS, og bare en administrator kan velge skole manuelt. Ta kontakt med en administrator, eller vent til eleven er registrert i VIS.')
  }

  return null
}

module.exports = {
  assertManualContractAllowed
}
