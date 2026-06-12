# Pureservice Student ID Sync

Syncs Pureservice user IDs onto student contracts in the `kontrakter` MongoDB collection.

## Why

Downstream jobs need a stable reference to the correct Pureservice user for each student (e.g. to create or update tickets or the user with details from the elevkontrakt). Rather than doing per-student Pureservice lookups at runtime, this sync pre-fetches all students once and stores the Pureservice `id` directly on each contract document.

## How it works

1. Fetches all Pureservice users with `title == "Elev"` using the `/agent/api/user/` endpoint (paginated, 500 per page).
2. Builds an in-memory map of `email → pureserviceId` from the linked `emailaddresses` in the response.
3. Queries all documents from the `kontrakter` &  `historiske-avtaler-pc-ikke-innlevert` collection.
4. For each contract, looks up `elevInfo.upn` in the email map.
5. If a match is found and `pureserviceId` is missing or has changed, updates the document with `{ pureserviceId: <number> }`.

## Result field

The Pureservice numeric user ID is stored at the root of the contract document:

```json
{
  "elevInfo": { "upn": "ola.nordmann@skole.telemarkfylke.no", ... },
  "pureserviceId": 42
}
```

## Schedule

The `kontrakter`-collection syncs daily at **07:00** via Azure Functions timer trigger.
The `historiske-avtaler-pc-ikke-innlevert`-collection runs daily at **07:15** via Azure Functions timer trigger.

## Environment variables

| Variable  | Description                          |
|-----------|--------------------------------------|
| `PUS_URL` | Pureservice base URL, e.g. `https://telemark.pureservice.com` |
| `PUS_KEY` | Pureservice API key                                           |

Set these in `local.settings.json` for local development and in the Azure Function App configuration for production.

## Manual trigger (dev)

```
GET http://localhost:7071/api/dev/syncPureserviceStudents
```

Response:

```json
{
  "total": 1200,
  "updated": 43,
  "skipped": 1140,
  "notFound": 17
}
```

| Field      | Meaning                                                    |
|------------|------------------------------------------------------------|
| `total`    | Total contracts processed                                  |
| `updated`  | Contracts where `pureserviceId` was added or changed       |
| `skipped`  | Contracts already up to date, or with UPN `Ukjent`        |
| `notFound` | Contracts whose UPN had no match in Pureservice            |

## Relevant files

| File | Purpose |
|------|---------|
| `src/lib/jobs/queryPureservice.js` | Pureservice API client (pagination, rate-limit retry) |
| `src/lib/jobs/syncPureserviceStudents.js` | Sync logic |
| `src/functions/syncPureserviceStudents.js` | Azure Function timer + dev HTTP trigger |

## Rate limiting

The Pureservice API returns HTTP 429 when rate limited. The client retries up to 7 times, honouring the `Retry-After` response header (or falling back to a 15-second wait). The bulk-fetch approach (one paginated call for all students) keeps the number of API requests minimal.
