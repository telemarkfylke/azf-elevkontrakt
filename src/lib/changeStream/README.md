# Change Stream → Pureservice Sync

Watches one or more MongoDB collections for relevant field changes and forwards those events to Pureservice by patching the corresponding user record. Also exposes an HTTP endpoint for on-demand full or partial syncs.

---

## Overview

A timer-triggered Azure Function (`watchChangeStream`) opens a MongoDB change stream at the database level every 30 minutes, listens for 27 minutes, and PATCHes the matching Pureservice user for each event. A per-collection mapper function controls which fields are sent and whether the document should be forwarded at all.

Events that cannot be delivered are placed on an Azure Storage Queue (DLQ) and retried by a second timer function (`requeueDlq`) every 5 minutes.

A third function (`syncToPureservice`) provides an HTTP endpoint for triggering a full or partial sync on demand — useful for initial setup and for resyncing individual records.

---

## Architecture

```
MongoDB Atlas
  └─ db.watch(pipeline)                ← database-level, filtered by collection + operationType
       │
       ▼
watchChangeStream  (timer, every 30 min)
  ├─ acquireLease()                    ← Blob lease prevents two instances running simultaneously
  ├─ readResumeToken()                 ← resumes from last successfully forwarded event
  ├─ mapper(event.fullDocument, event) ← collection-specific mapping → { pusId, patch } | null
  ├─ patchUser(pusId, patch)           ← PATCH /agent/api/user/{pusId} with API key auth
  ├─ saveResumeToken(event._id)        ← advance token after each successful forward
  └─ sendToDlq(event, error)           ← on forward failure: queue event for retry
       │
       ▼
requeueDlq  (timer, every 5 min)
  └─ processDlq()                      ← retry queued events, exponential back-off, max 5 attempts

syncToPureservice  (HTTP POST)
  └─ for each collection in mappers:   ← full sync or partial (by _id)
       mapper(doc) → patchUser(...)
```

### Files

| File | Purpose |
|---|---|
| `buildPipeline.js` | Builds the MongoDB `$match` pipeline from `watchCollections` config |
| `resumeToken.js` | Blob Storage read/write for the resume token + distributed lease |
| `forwardChange.js` | Looks up the mapper, then calls `patchUser` via `queryPureservice.js` |
| `deadLetterQueue.js` | Sends failed events to the DLQ; retries them with back-off |
| `retry.js` | Generic retry with exponential back-off |
| `mappers/index.js` | Mapper registry — one entry per watched collection |
| `mappers/{collection}.js` | Per-collection mapper: MongoDB doc → Pureservice patch payload |

---

## Configuration

All settings are read from `config.js`.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Yes | — | Storage account for Blob (resume token + lease) and Queue (DLQ) |
| `CHANGE_STREAM_WATCH_COLLECTIONS` | Yes | `[]` | JSON array describing which collections and fields to watch (see below) |
| `MONGODB_DB_NAME` | Yes | — | MongoDB database name — shared with the rest of the app |
| `PUS_URL` | Yes | — | Pureservice base URL (e.g. `https://telemark.pureservice.com`) — shared with rest of app |
| `PUS_KEY` | Yes | — | Pureservice API key — shared with rest of app |
| `CHANGE_STREAM_TOKEN_BLOB_CONTAINER` | No | `change-stream-state` | Blob container for the resume token |
| `CHANGE_STREAM_TOKEN_BLOB_NAME` | No | `resume-token.json` | Blob name for the resume token |
| `CHANGE_STREAM_DLQ_NAME` | No | `change-stream-dlq` | Azure Storage Queue name for the DLQ |

### CHANGE_STREAM_WATCH_COLLECTIONS

A JSON-encoded array stored as an Azure Function App Setting. Controls which collections and operation types trigger forwarding.

**Important:** only collections that also have a registered mapper in `mappers/index.js` will be forwarded. If a collection is listed here but has no mapper, `forwardChange` will throw an error.

```json
[
  {
    "collection": "kontrakter",
    "fields": [],
    "includeInserts": true,
    "includeDeletes": false
  },
  {
    "collection": "historiske-avtaler-pc-ikke-innlevert",
    "fields": [],
    "includeInserts": false,
    "includeDeletes": false
  }
]
```

| Property | Type | Description |
|---|---|---|
| `collection` | `string` | MongoDB collection name — must exactly match the name in Atlas |
| `fields` | `string[]` | Controls pipeline-level field filtering (see note below). Use `[]` to forward all updates. |
| `includeInserts` | `boolean` | Forward insert events |
| `includeDeletes` | `boolean` | Forward delete events |

#### `fields` and the dot-notation limitation

The `fields` array adds `$match` conditions to the MongoDB aggregation pipeline. Each entry adds a condition that checks whether `updateDescription.updatedFields.<field>` exists.

This works correctly for **top-level fields** (e.g. `"data"`, `"fakturaInfo"`). It does **not** work for **dot-notation paths** (e.g. `"fakturaInfo.rate1.status"`), because MongoDB's `$match` dot notation navigates nested objects — it cannot match a flat string key like `"fakturaInfo.rate1.status"` that `$set` stores in `updatedFields`.

**Recommendation:** use `"fields": []` to pass all updates through the pipeline and do field-level filtering inside the mapper instead (see Mapper section below). This avoids the limitation entirely and keeps filtering logic in one place.

---

## Mappers

Location: `src/lib/changeStream/mappers/`

Each mapper exports a single function:

```js
/**
 * @param {object} doc          - Full MongoDB document (fullDocument from the change event)
 * @param {object} [changeEvent] - Raw change stream event. Provided on the change stream path,
 *                                 omitted on the full-sync path. Use for field-level filtering.
 * @returns {{ pusId: number, patch: object } | null}
 */
module.exports = (doc, changeEvent) => {
  if (!doc.pureserviceId) return null   // skip — Pureservice ID not yet set

  // Optional: only forward if a relevant field changed.
  // updatedFields stores $set paths as flat string keys, so use startsWith for dot-notation paths.
  if (changeEvent) {
    const updatedKeys = Object.keys(changeEvent.updateDescription?.updatedFields ?? {})
    if (!updatedKeys.some(k => k.startsWith('fakturaInfo'))) return null
  }

  return {
    pusId: doc.pureserviceId,           // Pureservice user ID to PATCH
    patch: {
      // Fields to update. Use PusUserInput names from:
      // azf-entraid-sync/src/adapters/pus/pusTypes.ts
      cf_2: someValue
    }
  }
}
```

**`changeEvent` is `undefined` on the full-sync path** (`syncToPureservice`), so the field filter block is skipped and every document with a `pureserviceId` is forwarded — which is the correct behaviour for a sync.

**Returning `null`** skips the document silently — no Pureservice call is made and no error is logged.

### Registering a new mapper

1. Create `src/lib/changeStream/mappers/{collectionName}.js`
2. Add an entry to `src/lib/changeStream/mappers/index.js`:
   ```js
   module.exports = {
     kontrakter: require('./kontrakter'),
     'my-collection': require('./myCollection')  // ← add here
   }
   ```
3. Add the collection to `CHANGE_STREAM_WATCH_COLLECTIONS` in app settings.

---

## On-demand Sync Endpoint

`POST /changeStream/syncToPureservice`

Syncs documents from all mapped collections to Pureservice. Uses the same mappers as the change stream watcher. The `changeEvent` argument is not passed, so field-level filters inside mappers are bypassed — all documents with a `pureserviceId` are forwarded.

### Full sync (all documents)

```http
POST /changeStream/syncToPureservice
Content-Type: application/json

{}
```

### Partial sync (specific documents by _id)

```http
POST /changeStream/syncToPureservice
Content-Type: application/json

{ "ids": ["<ObjectId>", "<ObjectId>"] }
```

### Response

HTTP `200` if all syncs succeeded, `207` if any failed.

```json
{
  "kontrakter": {
    "total": 150,
    "synced": 148,
    "skipped": 1,
    "failed": 1
  }
}
```

- `skipped`: mapper returned `null` (e.g. document has no `pureserviceId`)
- `failed`: Pureservice PATCH failed after retries — check logs for details

---

## Dev HTTP Endpoints

Both timer-triggered functions expose an HTTP GET endpoint for manual invocation during local development:

| Endpoint | Triggers |
|---|---|
| `GET /api/dev/watchChangeStream` | Runs one watcher cycle (55-second listen window) |
| `GET /api/dev/requeueDlq` | Processes the DLQ once |

---

## Infrastructure Prerequisites

An Azure Storage account is required. Set its connection string in `AZURE_STORAGE_CONNECTION_STRING`. The Blob container and Storage Queue are **created automatically on first run**.

| Resource | Default name | Purpose |
|---|---|---|
| Blob container | `change-stream-state` | Resume token + distributed lease |
| Blob container | `change-stream-dlq-overflow` | Overflow storage for DLQ messages > 60 KB |
| Storage Queue | `change-stream-dlq` | Dead letter queue |

---

## Resume Tokens

The resume token is saved after each successfully forwarded event. On the next function run the change stream opens from that token, so no events are missed between runs.

**On first run** (no token blob exists): the stream opens from the current tip of the oplog. Historical events are not replayed — use the sync endpoint to do an initial full sync first.

**On oplog window expiry** (MongoDB error code 286): the function clears the stored token, logs an error alert, and the next run starts fresh from the tip of the oplog.

---

## Distributed Locking

The resume token blob doubles as the distributed lock. Before opening the change stream the function acquires a 60-second Blob lease on the token blob. If the lease is already held (e.g. during scale-out), the function logs and exits immediately. The lease is renewed every 30 seconds while the stream is open and released unconditionally in the `finally` block.

Saving the resume token passes the active lease ID so Azure accepts the write on a leased blob.

---

## Dead Letter Queue

Events land in the DLQ when `forwardChange` fails after 3 retries.

**Retry behaviour:**
- Max 5 attempts total
- Back-off via `visibilityTimeout`: 5 min → 10 min → 20 min → 40 min
- After 5 failed attempts: message is deleted and an error is logged

**64 KB overflow:** if a change event's `fullDocument` would push the DLQ message over 60 KB, the `fullDocument` is stored in the `change-stream-dlq-overflow` Blob container and only a reference is kept in the queue message.

**Note:** the target system (Pureservice) may receive the same event more than once after a crash between a successful `patchUser` call and `saveResumeToken`. Pureservice PATCH is idempotent so this is safe.

---

## Local Development

1. Set the required env vars in `local.settings.json`:
   ```json
   {
     "Values": {
       "AZURE_STORAGE_CONNECTION_STRING": "<your-storage-connection-string>",
       "MONGODB_DB_NAME": "<your-db-name>",
       "CHANGE_STREAM_WATCH_COLLECTIONS": "[{\"collection\":\"kontrakter\",\"fields\":[],\"includeInserts\":true,\"includeDeletes\":false}]",
       "PUS_URL": "https://telemark.pureservice.com",
       "PUS_KEY": "<your-api-key>"
     }
   }
   ```

2. Start the function host:
   ```
   func start
   ```

3. **Test the watcher manually** (avoids waiting for the 1-minute timer):
   ```
   GET http://localhost:7071/api/dev/watchChangeStream
   ```

4. **Test the sync endpoint:**
   ```bash
   # Full sync
   curl -X POST http://localhost:7071/api/changeStream/syncToPureservice \
        -H "Content-Type: application/json" -d '{}'

   # Partial sync by _id
   curl -X POST http://localhost:7071/api/changeStream/syncToPureservice \
        -H "Content-Type: application/json" \
        -d '{"ids": ["<ObjectId>"]}'
   ```

5. **Test the DLQ processor:**
   ```
   GET http://localhost:7071/api/dev/requeueDlq
   ```

6. **Test the distributed lock:** open a second terminal and run `func start` again — when the timer fires, the second instance should log "Skipping run — another instance holds the lease".
