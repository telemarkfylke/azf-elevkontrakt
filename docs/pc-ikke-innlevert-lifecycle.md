# The `historiske-avtaler-pc-ikke-innlevert` lifecycle

How a contract enters the "pc ikke innlevert" collection, what happens to it while it sits
there, and how it leaves.

## What the collection means

`historiske-avtaler-pc-ikke-innlevert` (`MONGODB_HISTORIC_PC_NOT_DELIVERED_COLLECTION`) holds
contracts for students who are **no longer students**, but whose contract is **not settled** -
the PC was never handed back, or an invoice is still outstanding. It is a holding pen, not a
final archive; `historiske-avtaler` is the final archive.

The single rule deciding which of the two a contract belongs in is
`determineHistoryMoveTarget` (`src/lib/jobs/contractChecks.js`):

```
every rate in Betalt | Kreditert                                          → historiske-avtaler
returned === 'true'  AND every rate in Betalt | Skal ikke betale | Ikke Fakturert |
                                       Utlån faktureres ikke | Kreditert   → historiske-avtaler
boughtOut === 'true' AND every rate in Betalt | Skal ikke betale |
                                       Utlån faktureres ikke | Kreditert   → historiske-avtaler
anything else                                        → historiske-avtaler-pc-ikke-innlevert
```

`Fakturert` and `Overført inkasso` (and any unrecognized status) therefore always block the
final archive - they represent an unresolved invoice. Note `Ikke Fakturert` is acceptable for a
*returned* PC (nothing was ever billed, and never will be) but not for a *bought-out* one (the
buyout itself still has to be paid).

The first clause is the **fully-paid** path: a contract that owes nothing is done regardless of
what happened to the PC, so it archives even when neither `returned` nor `boughtOut` was ever
recorded - a Leieavtale paid for all three years is effectively the student's machine. Be aware
of the trade-off this makes: a PC that was never handed back and never bought out stops appearing
in this collection once the contract is paid up, so it is no longer on any outstanding-hardware
worklist. `Skal ikke betale` and `Utlån faktureres ikke` deliberately do **not** count as paid
here - they mean nothing was owed, not that anything was settled, so such a contract still needs
a PC disposition to leave.

Because this rule only ever looks at the contract's own `fakturaInfo`, it cannot see the
`invoices` collection - which is what the invoice gate below is for.

## The invoice gate

A contract can look completely settled in its own `fakturaInfo` while an invoice against it is
still unpaid. The `invoices` collection holds two kinds of document, both keyed by
`customerContractId`:

- **`buyOut`** - mirrors rates that also exist in the contract's `fakturaInfo`.
- **`extraInvoice`** - a damage charge or similar, with **no counterpart in `fakturaInfo` at
  all**. This is the case that motivates the gate: the rate rule structurally cannot see it.

So a contract never reaches `historiske-avtaler` while any invoice against it is unsettled. This
applies to **both** archive paths - `updateStudentInfo` on the way in and
`archiveResolvedPcIkkeInnlevert` on the way out - and lives in
`src/lib/jobs/invoiceChecks.js` so the two cannot diverge.

An invoice counts as settled only when its **top-level `status` and every entry in `rates[]`** are
`Betalt` or `Kreditert`. Both halves are needed - the top-level status is recomputed from
`rates[]` only inside the manual `repairBuyOutInvoiceStatuses` job, so a `buyOut` invoice's
top-level value can be stale. An `extraInvoice` carries `rates: []` and is decided by its
top-level status alone.

This is deliberately stricter than `TERMINAL_STATUSES` in `repairBuyOutInvoiceStatuses`, which
also counts `Overført inkasso`: an invoice reaching a final state is not the same as the money
being settled, and inkasso already blocks on the contract side.

The query matches `customerContractId` in both `ObjectId` and string form; it is written as a raw
`ObjectId` (`processInvoices.js`), but a missed invoice would mean wrongly archiving a contract
that still owes money, so both are covered.

## 1. Getting in

`updateStudentInfo` (`src/lib/jobs/updateStudentInfo.js`, timer `0 6 * * *`) is the only
automated router into the collection. Per contract in `kontrakter`:

1. Asks FINT whether the person is still a student with an active elevforhold.
2. If not, stamps `notFoundInFINT.date` and leaves the contract in `kontrakter`.
3. On a later run, once that date is **more than 5 days old**, calls
   `determineHistoryMoveTarget` and moves the contract to whichever collection it names.
4. Before actually archiving to `historiske-avtaler`, applies the invoice gate: if any invoice
   against the contract is unsettled, it is routed here to the holding pen instead. It then leaves
   the normal way, once the invoice is paid and the daily sweep sees it.

The 5-day grace period exists so a transient FINT gap or a student between school years doesn't
archive an active contract.

Step 4 matters because `historiske-avtaler` is a one-way destination: no job revisits it, and the
Pureservice link has been cleared by the time the document lands there (see "Why leaving matters
beyond tidiness"). A contract that still owes money must not end up there.

## 2. Sitting there

Documents in this collection are **not** frozen. Several jobs keep writing to them in place:

| Job | Trigger | What it writes |
|---|---|---|
| `updatePaymentStatusPCNotDelivered` | timer `0 4 * * *` | rate `status` → `Betalt` / `Kreditert` from Xledger |
| `archiveResolvedPcIkkeInnlevert` | timer `0 45 4 * * *` | nothing - moves settled contracts out, see below |
| `syncPureserviceStudentsPcIkkeLevert` | timer `15 7 * * *` | `pureserviceId` / Pureservice student sync |
| `syncPureserviceAssetLifecycle` | timer `0 0 21 * * *` | `pcInfo.released` / `returned` / `boughtOut`, plus buyout invoices |
| `updatePCStatus` | HTTP, called by Pureservice | `pcInfo.*` (falls back to this collection when the contract isn't in `kontrakter`) |
| `handleDbRequest` PUT | HTTP, admin UI | `pcInfo.*` via `updateContractPCStatus`, or arbitrary fields via `updateDocument` |
| `markCherwellPcReturns` | manual, `devTesting.js` | one-off `pcInfo.returned` backfill from a Cherwell export |

Every `pcInfo` write goes through `updateContractPCStatus` (`src/lib/jobs/queryMongoDB.js`),
never a hand-rolled `$set`: `pcInfo` is a state machine, and that function is the single place
that knows a PC cannot be both released and returned.

## 3. Getting out

Because of step 2, a contract routinely *becomes* settled after it was archived here - a rate
gets paid, or the PC is finally handed in and registered in Pureservice. Nothing re-ran the
routing decision, so those contracts used to accumulate indefinitely, waiting for someone to
notice them in the admin UI.

**`archiveResolvedPcIkkeInnlevert`** (`src/lib/jobs/archiveResolvedPcIkkeInnlevert.js`, timer
`0 45 4 * * *`) closes that gap. It is deliberately just a second caller of
`determineHistoryMoveTarget` - it has no eligibility rules of its own, so the two directions can
never disagree.

1. Fetches candidates with a pre-filter - contracts that are returned, bought out, **or** have
   every rate in `Betalt`/`Kreditert`. The rule can only answer `historic` in one of those three
   shapes, so this is exactly the candidate set. The fully-paid branch is built from
   `FULLY_PAID_RATE_STATUSES`, imported from `contractChecks.js` rather than repeated, so the
   query and the rule cannot drift apart.
2. Skips (and reports) any document missing `pcInfo` or a rate `status` -
   `determineHistoryMoveTarget` dereferences those unguarded, and one malformed document must
   not abort the sweep.
3. Asks `determineHistoryMoveTarget`. Anything but `historic` stays put and is reported under
   `skippedStillUnresolved` **together with its three rate statuses**, which is the whole
   explanation for the skip.
4. Applies the invoice gate (above). A blocked contract is reported under
   `skippedUnsettledInvoices` with the offending invoices.
5. Otherwise `moveAndDeleteDocument(_id, 'historic', 'pcIkkeInnlevert')`.

Processing is strictly sequential, not `Promise.all`: each move to `historic` issues a
Pureservice `patchUser` call (see below), and an end-of-year mass return can put hundreds of
documents in here at once. Same reasoning as
[docs/pureservice-asset-lifecycle.md](pureservice-asset-lifecycle.md#rate-limiting).

For step 4 the sweep fetches **all** candidates' invoices in one query and groups them by
contract id (`fetchInvoicesByContract`) - the bulk pre-filter pattern from
`syncPureserviceAssetLifecycle`, not one query per candidate. `updateStudentInfo` uses the
single-contract `getUnsettledInvoices` instead, since only a handful of documents per run reach
the archive decision there.

The **manual** route out is unchanged and still available: `DELETE /api/handleDbRequest` with
`{ contractID, targetCollection: 'historic', sourceCollection: 'pcIkkeInnlevert' }`, which is
what the admin UI calls.

### Why leaving matters beyond tidiness

`moveAndDeleteDocument`'s `historic` branch is the only place that resets `cf_2` in Pureservice
and drops `pureserviceId` from the document - contracts in `historiske-avtaler` are done for
good and no mapper watches that collection, so a stale value there would never be corrected. A
contract stranded in `historiske-avtaler-pc-ikke-innlevert` therefore also keeps a stale
Pureservice link forever. If that `patchUser` call fails the whole move is aborted (`502`) and
the document is left in place, to be retried on the next run.

## Dry run

Defaults to a **dry-run preview**, matching this codebase's
`markCherwellPcReturns(false)` / `mergeAndArchiveDuplicateContracts(false)` convention. No writes
happen unless `dryRun: false` is passed explicitly. The timer trigger opts in at its call site;
the dev HTTP endpoint stays a safe preview unless `?dryRun=false` is given. A dry run also skips
the Teams report, so the dev endpoint can be poked without notifying anyone.

## Schedule

`0 45 4 * * *` - daily at 04:45, deliberately at the back of the early-morning chain:
`updatePaymentStatusPCNotDelivered` (04:00) refreshes rate statuses in this very collection,
followed by the extra-invoice (04:15) and buyout (04:30) sweeps. 04:45 sees all of their writes
plus the previous evening's `syncPureserviceAssetLifecycle` (21:00) `pcInfo` backfill, and still
lands before `updatePaymentStatus` (05:00) and `updateStudentInfo` (06:00).

## Manual trigger (dev)

```
GET http://localhost:7071/api/dev/archiveResolvedPcIkkeInnlevert
GET http://localhost:7071/api/dev/archiveResolvedPcIkkeInnlevert?dryRun=false
```

Example dry-run response:

```json
{
  "dryRun": true,
  "candidates": 34,
  "archived": [
    { "documentId": "...", "navn": "...", "kontraktType": "Leieavtale",
      "rateStatuses": ["Betalt", "Betalt", "Betalt"], "moved": false }
  ],
  "skippedStillUnresolved": [
    { "documentId": "...", "navn": "...", "kontraktType": "Leieavtale",
      "rateStatuses": ["Betalt", "Fakturert", "Ikke Fakturert"] }
  ],
  "skippedUnsettledInvoices": [
    { "documentId": "...", "navn": "...", "kontraktType": "Leieavtale",
      "rateStatuses": ["Betalt", "Betalt", "Betalt"],
      "invoices": [
        { "invoiceId": "...", "type": "extraInvoice", "status": "Ikke Fakturert", "rateStatuses": [] }
      ] }
  ],
  "skippedIncomplete": [],
  "errors": []
}
```

## Relevant files

| File | Purpose |
|------|---------|
| `src/lib/jobs/contractChecks.js` | `determineHistoryMoveTarget` - the single eligibility rule, shared by both directions |
| `src/lib/jobs/invoiceChecks.js` | The invoice gate - `isInvoiceSettled`, `getUnsettledInvoices`, `fetchInvoicesByContract`, also shared by both directions |
| `src/lib/jobs/updateStudentInfo.js` | Routes contracts *into* the collection when a student leaves |
| `src/lib/jobs/archiveResolvedPcIkkeInnlevert.js` | Sweeps settled contracts *out* to `historiske-avtaler` |
| `src/functions/archiveResolvedPcIkkeInnlevert.js` | Timer + dev HTTP trigger |
| `src/lib/jobs/queryMongoDB.js` | `moveAndDeleteDocument` (incl. the Pureservice `cf_2` reset), `updateContractPCStatus` |
| `src/lib/jobs/processInvoices.js` | Writes the `buyOut` / `extraInvoice` documents the invoice gate reads |
| `src/lib/jobs/serverJobs/miscCleanUpJobs.js` | `repairBuyOutInvoiceStatuses` - resyncs invoice statuses from contracts |
| `src/functions/handleDbRequest.js` | The manual, admin-UI-driven move (`DELETE`) |
| `docs/pureservice-asset-lifecycle.md` | The job that backfills `pcInfo` here from Pureservice |
