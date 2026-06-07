# Triage Baseline Cadence

The Triage menu's Baseline mode reads from a per-customer
`baseline_triaged_event` corpus that the deployment scheduler
fills via a recurring HTTP call. The route runs as a system actor
(no user session) and is gated by a shared internal secret.

A second, independent surface — the
[hourly low-and-slow Story sweep](triage-lowslow-sweep.md) — runs in
parallel to this 15-minute cadence. It has its own cron entry, route,
dispatcher, token, and watermark, and produces the low-and-slow Story
rules (R6/R2) over a 24-hour window; the cadence documented here is
unaffected by it.

## What the cadence does

Each invocation runs one ingestion pass for a single customer-tenant
DB. The pass walks pages of the upstream `eventListWithTriage`
resolver in order, applies the active exclusion set in-memory, and
INSERTs both:

- the **observed-event metadata** for every standard-filter survivor
  into `observed_event_meta` (30-day retention, used by the
  four-selector window-aggregate signals); and
- **every standard-filter survivor** into `baseline_triaged_event`
  (180-day retention, read directly by the Triage menu) with a
  per-event `raw_score` (RFC 0001 §3) and `selector_tags` set. The
  menu's strictness slider applies a read-time cutoff against the
  derived `baseline_score`, which the read path computes as
  `cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score)`
  — `raw_score` is the stored input, `baseline_score` is the
  read-time percentile the slider thresholds against. The cadence
  does not gate on score at INSERT time.

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
  "baselineInserted": 142,
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

## Dispatcher route — `POST /api/internal/triage/baseline/dispatch`

The 15-minute fan-out lives behind a sibling route the in-repo `cron`
service hits exactly once per tick. The dispatcher enumerates active
customers (`SELECT id FROM customers WHERE status = 'active'`) and
runs one cadence pass per customer with bounded concurrency and a
per-customer timeout. The per-customer route stays unchanged —
operators can still POST `{customer_id: N}` for a single-customer
manual run.

```text
POST /api/internal/triage/baseline/dispatch
Authorization: Bearer <TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN>
Content-Type: application/json

(no body)
```

Response:

```json
{
  "overall": "ok",
  "perCustomer": [
    {
      "customerId": 1,
      "status": "ok",
      "observedInserted": 142,
      "baselineInserted": 142,
      "lastEventCursor": "1234567890123456789"
    }
  ]
}
```

`perCustomer[].status` is closed:

| Value | Source | Meaning |
| :-- | :-- | :-- |
| `ok` | cadence runner | Normal successful pass; rows ingested, watermark advanced. |
| `skipped` | cadence runner | Advisory lock held by a concurrent run, or no new pages — normal "nothing to do". |
| `failed` | cadence runner | Cadence transaction rolled back; `error` populated. |
| `timeout` | dispatcher | Per-customer call exceeded its effective timeout — the lesser of `TRIAGE_BASELINE_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` (default 15 min) and the remaining total-dispatcher budget. The dispatcher cancelled the runner via `AbortSignal`; the in-flight page rolled back. The total budget bound also applies to already-running customers when the dispatcher's overall deadline elapses, so the dispatcher always returns within `TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`. |
| `skipped-timeout` | dispatcher | Total dispatcher timeout (`TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`, default 14 min) reached before this customer was attempted; the next 15-minute tick picks them up. |

`overall` is derived deterministically:

- `ok` ⇔ every per-customer status is `ok` or `skipped` (a normal
  skip is part of the steady state, not a failure).
- `partial` ⇔ at least one per-customer status is `failed`,
  `timeout`, or `skipped-timeout`, and the dispatcher itself
  completed.
- `failed` (HTTP 500) ⇔ the dispatcher itself failed (e.g. customer
  enumeration query errored). `perCustomer` may be empty.

A single customer's failure does not abort the others — the
dispatcher reports `partial` and continues.

## Runbook entry — schedule the cadence endpoint

**The `cron` service in `docker-compose.yml` already wires this** —
see `infra/cron/crontab` for the entry and
`infra/cron/run-triage-baseline-dispatch.sh` for the wrapper script.
A `docker compose --profile prod up -d` boot is sufficient to start
the 15-minute cadence; no external scheduler config is required.

The cron service depends on `next-app` becoming healthy (the
`/api/health` readiness gate) before firing its first tick, so a
half-up backend cannot receive a dispatcher request. The wrapper
script captures every response body to
`/var/log/cron/cron-cadence-<ts>.json` inside the cron container
(persisted via the `cron-logs` named volume) and emits a one-line
summary to stdout per invocation that `docker compose logs cron`
surfaces.

Operators running outside the bundled compose may use the same
dispatcher route from any external scheduler. Recommended cadence is
**every 15 minutes** (the dispatcher fans out per-customer
internally):

```bash
curl -sS -o /tmp/dispatch.json -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 840 \
  -X POST \
  -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '' \
  "$BFF_BASE_URL/api/internal/triage/baseline/dispatch"
```

Keep `--max-time` at-or-above the dispatcher total timeout
(`TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`, default 840000ms =
840s) and strictly below the 15-minute (900s) cron interval, so the
application-level timeout — which produces the structured `timeout`
/ `skipped-timeout` rows — wins over the network-level timeout
(which surfaces as a transport failure with no body) and successive
ticks cannot overlap. The bundled cron wrapper derives `--max-time`
from `TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS` automatically, so
the two values stay in sync as long as both are set in the same
`.env`. External schedulers must update their cap manually whenever
the dispatcher knob is retuned.

Per-customer manual runs still go through the cadence route:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  "$BFF_BASE_URL/api/internal/triage/baseline/cadence" \
  -d '{"customer_id": 1}'
```

Initial provisioning checklist:

1. Provision a strong random token for
   `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`. Store it in your
   secrets manager, rotate on a normal cadence, never check it in.
2. Set the env var in `.env` (the `cron` service inherits the same
   `env_file: .env` as `next-app`). The route refuses every
   request when the env var is unset, so the dispatcher must
   explicitly load it before the first tick.
3. Verify the first scheduled run by `docker compose logs cron` and
   tailing the timestamped response body under `/var/log/cron/`.
   A healthy first run on a quiet deployment reports modest
   counters; a `status: 'skipped'` on a first run after an
   interrupted tick is expected (the previous run is still
   finishing) and resolves on the subsequent pass.

## Monitoring

`200 / overall: 'partial'` is HTTP-success — a naive `curl -fsS`
would treat it as fine. To prevent silent partial failures from
accumulating, **alert on `overall != 'ok'`**. There are three
keying surfaces:

1. The dispatcher emits one structured `console.log` line per
   invocation tagged `triage_baseline_dispatch` carrying `overall`,
   per-customer status counts, and per-customer counters. This is
   the canonical line; key your alerting on it. The same line is
   also emitted on dispatcher self-failure (e.g. customer
   enumeration error or enumeration-timeout) with
   `overall: 'failed'`, an empty `perCustomer`, all counters at 0,
   and an `error` field — so a single alert rule on
   `overall != 'ok'` catches both partial and self-failure cases.
2. The cron wrapper script (`run-triage-baseline-dispatch.sh`)
   re-emits a human-readable warning to stderr on `overall != 'ok'`,
   which surfaces in `docker compose logs cron`.
3. `baseline_corpus_state.last_run_status` per customer captures
   the most recent terminal status; a sweep that finds any row
   with `last_run_status = 'failed'` older than 30 minutes (two
   full 15-minute cadence ticks) is a confirmed problem.

The wrapper script intentionally exits 0 on `overall: 'partial'` so
cron's MAILTO does not double-page — alerting on the structured log
line is the recovery path. Auth misconfiguration (HTTP 401/403) and
transport failures (DNS, connection refused, `--max-time` reached)
do exit non-zero, since those are operator errors that need
immediate attention.

## Observability

Every successful pass updates `baseline_corpus_state` with:

- `last_run_status = 'ok'`
- `last_ingested_at = NOW()`
- `last_event_cursor = <end-cursor of last page>`
- `baseline_version = 'phase1b-four-selector'`
- `exclusions_fp = <fingerprint of active exclusion set>`

A failed pass leaves `last_run_status = 'failed'` with the error
text on `last_error`. Operators can sample these columns directly
to confirm the scheduler is wired up correctly without polling
the route every tick.
