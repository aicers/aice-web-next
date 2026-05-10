# Triage Baseline Cadence

The Triage menu's Baseline mode reads from a per-customer
`baseline_triaged_event` corpus that the deployment scheduler
fills via a recurring HTTP call. The route runs as a system actor
(no user session) and is gated by a shared internal secret.

## What the cadence does

Each invocation runs one ingestion pass for a single customer-tenant
DB. The pass walks pages of the upstream `eventListWithTriage`
resolver in order, applies the active exclusion set in-memory, and
INSERTs both:

- the **observed-event metadata** for every standard-filter survivor
  into `observed_event_meta` (30-day retention, used by future
  window-aggregate signals); and
- the **baseline-passing subset** into `baseline_triaged_event`
  (180-day retention, read directly by the Triage menu).

`baseline_corpus_state.last_event_cursor` is advanced atomically
with the per-page INSERTs so a failure rolls back to the previous
watermark without losing rows already committed.

## Endpoint

```text
POST /api/internal/triage/baseline/cadence
Authorization: Bearer <TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN>
Content-Type: application/json

{ "customer_id": <positive integer> }
```

The token is a shared secret read from
`TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`. The route refuses every
request when the env var is unset, and it constant-time compares
the provided value to avoid a timing oracle.

## Response

A successful pass returns HTTP 200 with the per-run counters:

```json
{
  "customerId": 7,
  "status": "ok",
  "observedInserted": 142,
  "baselineInserted": 9,
  "lastEventCursor": "1234567890123456789"
}
```

`lastEventCursor` is the decimal RocksDB primary key of the last
event scanned in this run (the upstream resolver builds connection
edges with `Edge::new(k.to_string(), ev)`, so the cursor is the
i128 key serialised as a decimal string up to 39 digits).

| Field | Meaning |
| :-- | :-- |
| `status` | `ok` if at least one page committed; `skipped` if the per-customer advisory lock was already held by another invocation; `failed` if a page rolled back. |
| `observedInserted` | Rows added to `observed_event_meta` this run. |
| `baselineInserted` | Rows added to `baseline_triaged_event` this run. |
| `lastEventCursor` | End cursor of the last raw page successfully scanned. |
| `error` | Present only on `failed`; the message that was persisted to `baseline_corpus_state.last_error`. |

Status codes other than 200:

| Status | Meaning |
| :-- | :-- |
| 400 | Malformed JSON or missing / non-positive `customer_id`. |
| 401 | Bearer token missing or does not match. |
| 404 | The supplied `customer_id` does not map to an active customer. |
| 500 | The cadence pass rolled back; the structured `failed` body still includes `error` so the scheduler can log it. |

## Concurrency

A second concurrent invocation for the same customer must not
double-ingest. Every per-page transaction starts by taking a
per-customer transaction-scoped advisory lock:

```sql
pg_try_advisory_xact_lock(hashtext('triage_baseline_cadence:' || customer_id))
```

If the lock is unavailable on the very first page, the runner
returns `status: 'skipped'` without touching `baseline_corpus_state`
— the next scheduled tick picks up where the previous run stopped.
Lock release is automatic on commit/rollback because the lock is
transaction-scoped, so multiple cadence pages do not stretch a
long-lived database transaction.

## Failure and retry

When a page rolls back the runner records the error in
`baseline_corpus_state.last_run_status = 'failed'` /
`last_error = <message>` and returns 500 with the structured body.
Subsequent scheduler ticks reattempt from `last_event_cursor`, so
a transient outage costs at most one missed page; the next pass
refills it.

The runner recognises one specific recovery shape:

- A competing scheduler tick that grabs the advisory lock between
  two of our page commits causes a clean stop at the last
  committed watermark and `status: 'ok'` with the partial counters.

## Runbook entry — schedule the cadence endpoint

Add the cadence route to the deployment scheduler in your release
runbook. The recommended cadence is **once per hour per customer**
(per discussion #447 §3.4). Hourly cadence keeps the corpus warm
without doubling the resolver load — the per-page commit + cursor
advance lets the next tick pick up from where the previous one
stopped, so a transient outage of one or two cycles is harmless.

1. Provision a strong random token for
   `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`. Store it in your
   secrets manager, rotate on a normal cadence, never check it in.
2. Set the env var on every BFF instance and on the scheduler that
   calls the route. The route refuses every request when the env
   var is unset, so the scheduler must explicitly load it before
   the first tick.
3. Wire a recurring caller (cron, Kubernetes `CronJob`, GitHub
   Actions schedule, etc.) that issues, once per hour per
   customer:

    ```bash
    curl -fsS -X POST \
      -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
      -H "Content-Type: application/json" \
      "$BFF_BASE_URL/api/internal/triage/baseline/cadence" \
      -d '{"customer_id": 1}'
    ```

    If you operate multiple customer-tenant DBs, fan out one HTTP
    call per `customer_id` per hour. Per-customer advisory locks
    let independent customers run concurrently.

4. Verify the first scheduled run by tailing the scheduler logs
   and confirming the JSON body parses cleanly. A healthy first
   run on a quiet deployment usually reports modest counters; a
   `status: 'skipped'` on a first run after an interrupted tick
   is expected (the previous run is still finishing) and should
   resolve on the subsequent pass.

## Observability

Every successful pass updates `baseline_corpus_state` with:

- `last_run_status = 'ok'`
- `last_ingested_at = NOW()`
- `last_event_cursor = <end-cursor of last page>`
- `baseline_version = 'phase1a-simple'`
- `exclusions_fp = <fingerprint of active exclusion set>`

A failed pass leaves `last_run_status = 'failed'` with the error
text on `last_error`. Operators can sample these columns directly
to confirm the scheduler is wired up correctly without polling
the route every tick.
