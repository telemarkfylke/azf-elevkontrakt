'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { listAccessGroups, searchCandidates, addMember, removeMember } = require('../accessGroups')
const { buildUserSearchUrl } = require('../queryMSGraph')
const { accessGroups, ADMIN_GROUP_ID } = require('../../datasources/access-groups')

const SCHOOL_GROUP = accessGroups.find(g => g.requirement === 'school').id
const DIGITAL_GROUP = accessGroups.find(g => g.requirement === 'digital').id
const SUFFIX = '@telemarkfylke.no'

const ME = { id: '11111111-1111-1111-1111-111111111111', displayName: 'Kari Nordmann', userPrincipalName: 'kari.nordmann@telemarkfylke.no', companyName: 'Telemark fylkeskommune', department: 'Teknologi og utvikling' }
const TEACHER = { id: '22222222-2222-2222-2222-222222222222', displayName: 'Ingrid Hansen', userPrincipalName: 'ingrid.hansen@telemarkfylke.no', companyName: 'Skien videregående skole', department: 'Administrasjon' }
const OFFICE = { id: '33333333-3333-3333-3333-333333333333', displayName: 'Jonas Hansen', userPrincipalName: 'jonas.hansen@telemarkfylke.no', companyName: 'Telemark fylkeskommune', department: 'Økonomi' }
const ELEV = { id: '44444444-4444-4444-4444-444444444444', displayName: 'Elev Elevsen', userPrincipalName: 'elev@skole.telemarkfylke.no' }
const CALLER = { upn: ME.userPrincipalName, oid: ME.id }

const graphError = (status, message = '') => {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status, data: { error: { message } } }
  return error
}

describe('buildUserSearchUrl', () => {
  test('searches name and UPN fields, employees only', () => {
    const url = decodeURIComponent(buildUserSearchUrl('ola', SUFFIX))
    for (const field of ['displayName', 'givenName', 'surname', 'userPrincipalName']) assert.ok(url.includes(`"${field}:ola"`))
    assert.ok(url.includes("endswith(userPrincipalName,'@telemarkfylke.no')"))
    assert.ok(url.includes('accountEnabled eq true'))
    assert.ok(url.includes('department'))
  })

  test('strips quotes that would break the search clause', () => {
    const url = decodeURIComponent(buildUserSearchUrl('ola" OR "x', SUFFIX))
    assert.ok(url.includes('"displayName:ola OR x"'))
  })
})

describe('listAccessGroups', () => {
  test('returns every group with members and requirement checks', async () => {
    const res = await listAccessGroups(CALLER, { getGroupMembers: async id => id === SCHOOL_GROUP ? [OFFICE, TEACHER] : [], getUserById: async () => ME })
    assert.equal(res.status, 200)
    assert.equal(res.jsonBody.length, accessGroups.length)
    const school = res.jsonBody.find(g => g.id === SCHOOL_GROUP)
    assert.deepEqual(school.members.map(m => m.displayName), ['Ingrid Hansen', 'Jonas Hansen'])
    assert.equal(school.members.find(m => m.id === OFFICE.id).requirement.ok, false)
  })

  test('502 graph-forbidden when the app lacks permission', async () => {
    const res = await listAccessGroups(CALLER, { getGroupMembers: async () => { throw graphError(403) }, getUserById: async () => ME })
    assert.equal(res.status, 502)
    assert.equal(res.jsonBody.reason, 'graph-forbidden')
  })
})

describe('searchCandidates', () => {
  test('marks members and requirement per hit', async () => {
    const res = await searchCandidates(SCHOOL_GROUP, 'hansen', { searchUsers: async () => [OFFICE, TEACHER], getGroupMembers: async () => [TEACHER], upnSuffix: SUFFIX })
    assert.equal(res.status, 200)
    const teacher = res.jsonBody.find(h => h.id === TEACHER.id)
    const office = res.jsonBody.find(h => h.id === OFFICE.id)
    assert.equal(teacher.isMember, true)
    assert.equal(office.isMember, false)
    assert.equal(office.requirement.ok, false)
  })

  test('400 for a query shorter than two characters', async () => {
    const res = await searchCandidates(SCHOOL_GROUP, ' a ', {})
    assert.equal(res.status, 400)
  })

  test('404 for a group outside the allowlist', async () => {
    const res = await searchCandidates('00000000-0000-0000-0000-000000000000', 'ola', {})
    assert.equal(res.status, 404)
  })
})

describe('addMember', () => {
  const deps = (user, add = async () => {}) => ({ getUserById: async () => user, addGroupMember: add, upnSuffix: SUFFIX })

  test('adds a user who meets the requirement', async () => {
    let added = null
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, deps(TEACHER, async (g, u) => { added = [g, u] }))
    assert.equal(res.status, 201)
    assert.deepEqual(added, [SCHOOL_GROUP, TEACHER.id])
  })

  test('422 when the requirement is not met and not forced', async () => {
    let called = false
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: OFFICE.id, caller: CALLER }, deps(OFFICE, async () => { called = true }))
    assert.equal(res.status, 422)
    assert.equal(res.jsonBody.reason, 'requirement-not-met')
    assert.equal(called, false)
  })

  test('adds anyway when forced', async () => {
    const res = await addMember({ groupId: DIGITAL_GROUP, userId: OFFICE.id, force: true, caller: CALLER }, deps(OFFICE))
    assert.equal(res.status, 201)
  })

  test('refuses accounts that are not employees', async () => {
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: ELEV.id, caller: CALLER }, deps(ELEV))
    assert.equal(res.status, 400)
    assert.equal(res.jsonBody.reason, 'not-employee')
  })

  test('409 when Graph says the member already exists', async () => {
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, deps(TEACHER, async () => { throw graphError(400, 'One or more added object references already exist for the following modified properties: \'members\'.') }))
    assert.equal(res.status, 409)
    assert.equal(res.jsonBody.reason, 'already-member')
  })

  test('400 for an invalid user id', async () => {
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: 'not-a-guid', caller: CALLER }, deps(TEACHER))
    assert.equal(res.status, 400)
  })

  test('404 when the user is not in Entra ID', async () => {
    const res = await addMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, { getUserById: async () => { throw graphError(404) } })
    assert.equal(res.status, 404)
  })
})

describe('removeMember', () => {
  test('removes a member', async () => {
    let removed = null
    const res = await removeMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, { removeGroupMember: async (g, u) => { removed = [g, u] } })
    assert.equal(res.status, 200)
    assert.deepEqual(removed, [SCHOOL_GROUP, TEACHER.id])
  })

  test('an administrator cannot remove themselves', async () => {
    const res = await removeMember({ groupId: ADMIN_GROUP_ID, userId: ME.id, caller: CALLER }, {})
    assert.equal(res.status, 409)
    assert.equal(res.jsonBody.reason, 'self-removal')
  })

  test('the last administrator cannot be removed', async () => {
    const res = await removeMember({ groupId: ADMIN_GROUP_ID, userId: TEACHER.id, caller: CALLER }, { getGroupMembers: async () => [TEACHER], getUserById: async () => ME })
    assert.equal(res.status, 409)
    assert.equal(res.jsonBody.reason, 'last-admin')
  })

  test('another administrator can be removed', async () => {
    const res = await removeMember({ groupId: ADMIN_GROUP_ID, userId: TEACHER.id, caller: CALLER }, { getGroupMembers: async () => [ME, TEACHER], removeGroupMember: async () => {}, getUserById: async () => ME })
    assert.equal(res.status, 200)
  })

  test('404 when Graph says the user is not a member', async () => {
    const res = await removeMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, { removeGroupMember: async () => { throw graphError(404) } })
    assert.equal(res.status, 404)
    assert.equal(res.jsonBody.reason, 'not-member')
  })
})

describe('administrator group is locked to Teknologi og utvikling', () => {
  const OTHER_ADMIN = { ...OFFICE, department: 'Økonomi' }

  test('canEdit is true for every group when the caller is in the department', async () => {
    const res = await listAccessGroups(CALLER, { getGroupMembers: async () => [], getUserById: async () => ME })
    assert.ok(res.jsonBody.every(g => g.canEdit))
  })

  test('canEdit is false only for the administrator group otherwise', async () => {
    const res = await listAccessGroups(CALLER, { getGroupMembers: async () => [], getUserById: async () => OTHER_ADMIN })
    assert.equal(res.jsonBody.find(g => g.id === ADMIN_GROUP_ID).canEdit, false)
    assert.ok(res.jsonBody.filter(g => g.id !== ADMIN_GROUP_ID).every(g => g.canEdit))
  })

  test('403 when adding an administrator from another department', async () => {
    let called = false
    const res = await addMember({ groupId: ADMIN_GROUP_ID, userId: TEACHER.id, caller: CALLER }, { getUserById: async id => id === CALLER.oid ? OTHER_ADMIN : TEACHER, addGroupMember: async () => { called = true }, upnSuffix: SUFFIX })
    assert.equal(res.status, 403)
    assert.equal(res.jsonBody.reason, 'admin-group-locked')
    assert.equal(called, false)
  })

  test('adds an administrator from the department', async () => {
    const res = await addMember({ groupId: ADMIN_GROUP_ID, userId: TEACHER.id, caller: CALLER }, { getUserById: async id => id === CALLER.oid ? ME : TEACHER, addGroupMember: async () => {}, upnSuffix: SUFFIX })
    assert.equal(res.status, 201)
  })

  test('403 when removing an administrator from another department', async () => {
    let called = false
    const res = await removeMember({ groupId: ADMIN_GROUP_ID, userId: TEACHER.id, caller: CALLER }, { getUserById: async () => OTHER_ADMIN, getGroupMembers: async () => [ME, TEACHER], removeGroupMember: async () => { called = true } })
    assert.equal(res.status, 403)
    assert.equal(called, false)
  })

  test('other groups are not affected by the department', async () => {
    const res = await removeMember({ groupId: SCHOOL_GROUP, userId: TEACHER.id, caller: CALLER }, { getUserById: async () => OTHER_ADMIN, removeGroupMember: async () => {} })
    assert.equal(res.status, 200)
  })
})
