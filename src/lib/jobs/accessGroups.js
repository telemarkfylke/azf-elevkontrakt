const { logger } = require('@vtfk/logger')
const graph = require('./queryMSGraph')
const { accessGroups, ADMIN_GROUP_ID, ADMIN_GROUP_EDITOR_DEPARTMENT } = require('../datasources/access-groups')
const { checkAccessRequirement } = require('../helpers/accessRequirement')
const { msGraph } = require('../../../config')

/**
 * Logic behind Innstillinger → Tilganger. Every function returns { status, jsonBody } for the
 * endpoint to hand back as is. Graph is injected through deps so the rules can be tested.
 *
 *   400 bad input  ·  403 caller may not change the administrator group
 *   404 unknown group, user or membership  ·  409 refused (already member, self-removal,
 *   last administrator)  ·  422 requirement not met and not forced
 *   502 Graph failed - reason 'graph-forbidden' means the app registration lacks a permission
 */

const logPrefix = 'accessGroups'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fail = (status, error, reason, extra = {}) => ({ status, jsonBody: { error, reason, ...extra } })

const graphFailure = (error, what) => {
  logger('error', [logPrefix, what, error.response?.status, error.response?.data?.error?.message || error.message])
  if (error.response?.status === 403) {
    return fail(502, 'Elevavtaler har ikke lov til å gjøre dette i Entra ID. Kontakt servicedesk.', 'graph-forbidden')
  }
  return fail(502, 'Fikk ikke kontakt med Entra ID. Prøv igjen om litt. Kontakt servicedesk hvis feilen fortsetter.', 'graph-error')
}

const findGroup = (groupId) => accessGroups.find(g => g.id === groupId)

const byName = (a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'nb')

// Only what the GUI shows, plus the requirement check for this group
const toPerson = (user, group) => ({
  id: user.id,
  displayName: user.displayName,
  userPrincipalName: user.userPrincipalName,
  companyName: user.companyName ?? null,
  department: user.department ?? null,
  officeLocation: user.officeLocation ?? null,
  jobTitle: user.jobTitle ?? null,
  requirement: checkAccessRequirement(user, group)
})

/**
 * True if the caller's department in Graph is the one allowed to change administrators.
 * Throws if Graph fails.
 */
const canEditAdminGroup = async (caller, getUserById) => {
  if (!caller?.oid) return false
  const user = await getUserById(caller.oid)
  return user?.department?.trim().toLowerCase() === ADMIN_GROUP_EDITOR_DEPARTMENT.toLowerCase()
}

const adminGroupLocked = () => fail(403, `Bare administratorer i ${ADMIN_GROUP_EDITOR_DEPARTMENT} kan endre hvem som er administrator.`, 'admin-group-locked')

// null if the caller may change the group, else the failure to return
const assertCanEdit = async (group, caller, getUserById) => {
  if (group.id !== ADMIN_GROUP_ID) return null
  try {
    return await canEditAdminGroup(caller, getUserById) ? null : adminGroupLocked()
  } catch (error) {
    return graphFailure(error, 'Klarte ikke hente innlogget bruker')
  }
}

/**
 * All groups with their members. canEdit says whether the caller may add and remove members.
 */
const listAccessGroups = async (caller, deps = {}) => {
  const { getGroupMembers = graph.getGroupMembers, getUserById = graph.getUserById } = deps
  try {
    const editAdmin = await canEditAdminGroup(caller, getUserById)
    const groups = await Promise.all(accessGroups.map(async group => {
      const members = await getGroupMembers(group.id)
      return {
        id: group.id,
        name: group.name,
        role: group.role,
        label: group.label,
        description: group.description,
        requirement: group.requirement,
        canEdit: group.id !== ADMIN_GROUP_ID || editAdmin,
        members: members.map(m => toPerson(m, group)).sort(byName)
      }
    }))
    return { status: 200, jsonBody: groups }
  } catch (error) {
    return graphFailure(error, 'Klarte ikke hente medlemmer')
  }
}

/**
 * Employees matching the query, marked with membership and requirement for the group.
 */
const searchCandidates = async (groupId, query, deps = {}) => {
  const { searchUsers = graph.searchUsers, getGroupMembers = graph.getGroupMembers, upnSuffix = msGraph.employeeUpnSuffix } = deps
  const group = findGroup(groupId)
  if (!group) return fail(404, 'Fant ikke tilgangsgruppen.', 'unknown-group')
  const q = String(query ?? '').trim()
  if (q.length < 2) return fail(400, 'Skriv minst to tegn.', 'query-too-short')

  try {
    const [users, members] = await Promise.all([searchUsers(q, upnSuffix), getGroupMembers(groupId)])
    const memberIds = new Set(members.map(m => m.id))
    const hits = users.map(u => ({ ...toPerson(u, group), isMember: memberIds.has(u.id) })).sort(byName)
    return { status: 200, jsonBody: hits }
  } catch (error) {
    return graphFailure(error, 'Søk etter ansatte feilet')
  }
}

/**
 * Adds a user to a group. A user who doesn't meet the group's requirement is only added with force.
 *
 * @param {{ groupId: string, userId: string, force?: boolean, caller?: { upn: string, oid: string } }} input
 */
const addMember = async ({ groupId, userId, force, caller }, deps = {}) => {
  const { getUserById = graph.getUserById, addGroupMember = graph.addGroupMember, upnSuffix = msGraph.employeeUpnSuffix } = deps
  const group = findGroup(groupId)
  if (!group) return fail(404, 'Fant ikke tilgangsgruppen.', 'unknown-group')
  if (!UUID_PATTERN.test(userId || '')) return fail(400, 'Mangler eller ugyldig bruker-id.', 'invalid-user-id')

  const locked = await assertCanEdit(group, caller, getUserById)
  if (locked) return locked

  let user
  try {
    user = await getUserById(userId)
  } catch (error) {
    if (error.response?.status === 404) return fail(404, 'Fant ikke brukeren i Entra ID.', 'user-not-found')
    return graphFailure(error, 'Klarte ikke hente brukeren')
  }

  if (!user.userPrincipalName?.toLowerCase().endsWith(upnSuffix.toLowerCase())) {
    return fail(400, 'Bare ansatte i fylkeskommunen kan få tilgang.', 'not-employee')
  }

  const requirement = checkAccessRequirement(user, group)
  if (!requirement.ok && force !== true) {
    return fail(422, requirement.message, 'requirement-not-met', { requirement, user: toPerson(user, group) })
  }

  try {
    await addGroupMember(groupId, userId)
  } catch (error) {
    // Graph answers 400 when the member is already there
    if (error.response?.status === 400 && /already exist/i.test(error.response?.data?.error?.message || '')) {
      return fail(409, `${user.displayName} har allerede rollen ${group.label}.`, 'already-member', { member: toPerson(user, group) })
    }
    return graphFailure(error, 'Klarte ikke legge til medlem')
  }

  logger('info', [logPrefix, `${caller?.upn} la til ${user.userPrincipalName} i ${group.name}`, requirement.ok ? '' : `(overstyrt: ${requirement.reason})`])
  return { status: 201, jsonBody: toPerson(user, group) }
}

/**
 * Removes a user from a group. An administrator can't remove themselves, and the last
 * administrator can't be removed, so nobody is left who can give access back.
 * Only administrators in ADMIN_GROUP_EDITOR_DEPARTMENT may change the administrator group.
 *
 * @param {{ groupId: string, userId: string, caller?: { upn: string, oid: string } }} input
 */
const removeMember = async ({ groupId, userId, caller }, deps = {}) => {
  const { getGroupMembers = graph.getGroupMembers, removeGroupMember = graph.removeGroupMember, getUserById = graph.getUserById } = deps
  const group = findGroup(groupId)
  if (!group) return fail(404, 'Fant ikke tilgangsgruppen.', 'unknown-group')
  if (!UUID_PATTERN.test(userId || '')) return fail(400, 'Mangler eller ugyldig bruker-id.', 'invalid-user-id')

  if (groupId === ADMIN_GROUP_ID) {
    if (caller?.oid && caller.oid.toLowerCase() === userId.toLowerCase()) {
      return fail(409, 'Du kan ikke fjerne deg selv fra Administrator.', 'self-removal')
    }
    const locked = await assertCanEdit(group, caller, getUserById)
    if (locked) return locked
    let members
    try {
      members = await getGroupMembers(groupId)
    } catch (error) {
      return graphFailure(error, 'Klarte ikke hente administratorer')
    }
    if (!members.some(m => m.id === userId)) return fail(404, 'Personen har ikke denne rollen.', 'not-member')
    if (members.length <= 1) return fail(409, 'Den siste administratoren kan ikke fjernes.', 'last-admin')
  }

  try {
    await removeGroupMember(groupId, userId)
  } catch (error) {
    if (error.response?.status === 404) return fail(404, 'Personen har ikke denne rollen.', 'not-member')
    return graphFailure(error, 'Klarte ikke fjerne medlem')
  }

  logger('info', [logPrefix, `${caller?.upn} fjernet ${userId} fra ${group.name}`])
  return { status: 200, jsonBody: { removed: userId } }
}

module.exports = {
  listAccessGroups,
  searchCandidates,
  addMember,
  removeMember
}
