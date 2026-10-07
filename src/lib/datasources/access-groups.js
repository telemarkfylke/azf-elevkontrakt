/**
 * The EntraID groups an administrator can manage from Innstillinger → Tilganger.
 * Also the allowlist: no other group id is ever read or changed.
 *
 * requirement: what a member must have in Graph to get any use of the role
 *   none    - no check
 *   school  - companyName or department is a school in tfk-schools.js
 *   digital - companyName is 'Digitale tjenester'
 *
 * A-TILGANG-ELEVKONTRAKT-R-BASIC and -RW-BASIC are not in use and left out.
 */
const accessGroups = [
  {
    id: '04a976a6-8014-43f9-ba42-4665514f91ff',
    name: 'A-TILGANG-ELEVKONTRAKT-RW-ADMINISTRATOR',
    role: 'elevkontrakt.administrator-readwrite',
    label: 'Administrator',
    description: 'Ser og har tilgang til alt, også Innstillinger.',
    requirement: 'none'
  },
  {
    id: '1a3a5464-2979-424d-bca5-38471d546990',
    name: 'A-TILGANG-ELEVKONTRAKT-W-SKOLE-ADMINISTRATOR',
    role: 'elevkontrakt.skoleadministrator-write',
    label: 'Skoleadministrator',
    description: 'Ser og endrer avtalene på sin egen skole.',
    requirement: 'school'
  },
  {
    id: '92006bdb-8346-488b-8c11-dc84836fc408',
    name: 'A-TILGANG-ELEVKONTRAKT-R-SKOLE-ADMINISTRATOR',
    role: 'elevkontrakt.skoleadministrator-read',
    label: 'Skoleadministrator (lese)',
    description: 'Ser avtalene på sin egen skole, men kan ikke endre.',
    requirement: 'school'
  },
  {
    id: '517aa007-1406-423e-af9a-8f716e4f7961',
    name: 'A-TILGANG-ELEVKONTRAKT-RW-BILLING',
    role: 'elevkontrakt.billing-readwrite',
    label: 'Fakturering',
    description: 'Lager fakturaer for elevene på sin egen skole.',
    requirement: 'school'
  },
  {
    id: 'e1978ace-0b08-4d01-9639-0f902dda92d2',
    name: 'A-TILGANG-ELEVKONTRAKT-R-BILLING',
    role: 'elevkontrakt.billing-read',
    label: 'Fakturering (lese)',
    description: 'Ser fakturaene på sin egen skole.',
    requirement: 'school'
  },
  {
    id: '9958fc60-8cab-45d2-a075-f0fae44c01d7',
    name: 'A-TILGANG-ELEVKONTRAKT-RW-IT-SERVICEDESK',
    role: 'elevkontrakt.itservicedesk-readwrite',
    label: 'IT-servicedesk',
    description: 'Ser avtalene i hele fylket og oppdaterer PC-status.',
    requirement: 'digital'
  }
]

const ADMIN_GROUP_ID = '04a976a6-8014-43f9-ba42-4665514f91ff'

// Only administrators in this department (Graph 'department') may add or remove administrators
const ADMIN_GROUP_EDITOR_DEPARTMENT = 'Teknologi og utvikling'

module.exports = {
  accessGroups,
  ADMIN_GROUP_ID,
  ADMIN_GROUP_EDITOR_DEPARTMENT
}
