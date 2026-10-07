const { app } = require('@azure/functions')
const { logger } = require('@vtfk/logger')
const { validateRoles } = require('../lib/auth/validateRoles.js')
const { decodeToken } = require('../lib/auth/decodeToken.js')
const { listAccessGroups, searchCandidates, addMember, removeMember } = require('../lib/jobs/accessGroups.js')

/**
 * Innstillinger → Tilganger: administrators give and remove roles by changing membership of the
 * EntraID groups in access-groups.js. Status codes are documented in lib/jobs/accessGroups.js.
 *
 * Needs Graph application permissions User.Read.All and GroupMember.ReadWrite.All.
 */

const ADMIN = ['elevkontrakt.administrator-readwrite']

// Returns the caller, or null if not an administrator
const authorize = (request, logPrefix) => {
  const authorizationHeader = request.headers.get('authorization')
  if (!validateRoles(authorizationHeader, ADMIN)) {
    logger('error', [logPrefix, 'Unauthorized access attempt'])
    return null
  }
  return decodeToken(authorizationHeader.split(' ')[1], ['upn', 'oid'])
}

const forbidden = { status: 403, body: 'Forbidden' }

app.http('accessGroups', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accessGroups',
  handler: async (request) => {
    const caller = authorize(request, 'accessGroups')
    if (!caller) return forbidden
    return listAccessGroups(caller)
  }
})

app.http('accessGroupsSearch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accessGroups/{groupId}/search',
  handler: async (request) => {
    if (!authorize(request, 'accessGroupsSearch')) return forbidden
    return searchCandidates(request.params.groupId, request.query.get('query'))
  }
})

app.http('accessGroupsAddMember', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'accessGroups/{groupId}/members',
  handler: async (request) => {
    const caller = authorize(request, 'accessGroupsAddMember')
    if (!caller) return forbidden
    let body
    try {
      body = await request.json()
    } catch {
      return { status: 400, jsonBody: { error: 'Ugyldig forespørsel.', reason: 'invalid-body' } }
    }
    return addMember({ groupId: request.params.groupId, userId: body?.userId, force: body?.force === true, caller })
  }
})

app.http('accessGroupsRemoveMember', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'accessGroups/{groupId}/members/{userId}',
  handler: async (request) => {
    const caller = authorize(request, 'accessGroupsRemoveMember')
    if (!caller) return forbidden
    return removeMember({ groupId: request.params.groupId, userId: request.params.userId, caller })
  }
})
