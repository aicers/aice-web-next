# Triage Low-and-Slow Sweep

The Triage menu's Story tab surfaces two **low-and-slow** correlation
rules — R6 (persistent low-and-slow) and R2 (multi-stage low-and-slow)
— that look for activity dispersed thinly across a 24-hour window. Such
clusters cannot be detected by the per-page cadence, whose rule window
is only one hour, so they are produced by a **separate hourly sweep**:
its own cron entry, its own internal route, its own dispatcher, its own
internal token, and its own `lowslow_finalized_through` watermark. This
page documents that operational surface.

The sweep is parallel to — not part of — the
[15-minute baseline cadence](triage-baseline-cadence.md). The cadence
ingests the upstream corpus and owns Story forward progress
(`story_finalized_through`); the sweep reads only the already-ingested
local corpus over a 24-hour window and never fetches from REview. The
two surfaces have separate dispatch routes, separate advisory locks,
separate tokens, and separate watermarks.

## What the sweep does

Each hourly tick fans out one low-and-slow sweep per active customer.
A single sweep runs as one transaction (the corpus is local — there is
no paging) and does two candidate-read passes over the same 24-hour
window:

- **R6 — persistent low-and-slow** (selector-keyed, issue #701): one
  source asset with dispersed activity spread thinly across at least
  three distinct hours within a 24-hour window — a periodic beacon or
  slow recon.
- **R2 — multi-stage low-and-slow** (category-keyed, issue #702): one
  source asset touching at least three distinct categories (at least
  one critical), in any order, across at least three distinct hours
  within a 24-hour window — the "slow R1".

R2 and R6 are read as two independent two-phase candidate sets (R2 is
category-keyed, R6 selector-keyed), not as a re-filter of one another,
so the same asset and window may produce both. Both ship from this one
sweep.

The per-page cadence rules **R1, R3, R4, R5 are untouched** — they stay
on the 1-hour per-page window and are produced by the cadence pipeline,
not by this sweep. The sweep adds R6/R2 only; it does not re-derive any
cadence-path rule.

### Horizon and detection window

The sweep must never finalize past a region the cadence may still be
filling, so its upper bound is the cadence's published watermark:

- **Horizon `H` = `baseline_corpus_state.story_finalized_through`** —
  the cadence's settled point. The sweep inherits the cadence's
  ingestion slop guarantee and never advances past `H`. If `H IS NULL`
  (the cadence has not settled any Stories yet) the sweep is a no-op.
- **Detection window** = 24 hours (`LOWSLOW_WINDOW_MS`). The
  member-scan looks back a full window so a cluster ending just past
  the watermark still sees its earlier members.

## Endpoint

The sweep is a **single fan-out route**. Unlike the cadence — which has
a per-customer `/cadence` endpoint *and* a separate `/dispatch`
fan-out — there is no operator-callable per-customer sweep endpoint.
The one route below *is* the fan-out: it enumerates active customers
(`SELECT id FROM customers WHERE status = 'active'`) and runs one sweep
per customer with bounded concurrency and a per-customer timeout.

```text
POST /api/internal/triage/baseline/lowslow-sweep
Authorization: Bearer <TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN>
Content-Type: application/json

(no body)
```

The token is a per-surface secret read from
`TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN` — **its own token, not shared
with the cadence**, so a leaked secret cannot pivot between the cadence
and sweep surfaces. The route refuses every request when the env var is
unset, and it constant-time compares the provided value to avoid a
timing oracle.

### Dispatch tuning

| Env var | Default | Meaning |
| :-- | :-- | :-- |
| `LOWSLOW_SWEEP_DISPATCH_CONCURRENCY` | 4 | Per-tick concurrency cap across customers. |
| `LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` | 15 min | Per-customer hard timeout. |
| `LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` | 55 min | Total dispatcher timeout, capped below the 60-minute cron interval so a slow tick cannot overlap the next one. A value above 55 minutes is clamped down with a warn log. |

The per-customer effective timeout is the lesser of
`LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` and the remaining
total-dispatcher budget. The dispatcher both aborts the runner and
binds `statement_timeout` DB-side, so a sweep stuck inside a 24-hour
scan is cancelled by Postgres and rolls back within budget rather than
holding its connection and advisory lock until the query finishes on
its own.

## Response

A dispatcher pass that completes returns HTTP 200 with an `overall`
verdict plus a `perCustomer` array:

```json
{
  "overall": "ok",
  "perCustomer": [
    {
      "customerId": 1,
      "status": "ok",
      "storiesInserted": 3
    }
  ]
}
```

This response centres on `overall` + `perCustomer[]` — there is **no**
`newWatermark`-style field in the response. Each `perCustomer` entry
carries `customerId`, `status`, `storiesInserted`, and an optional
`error`.

`perCustomer[].status` is closed:

| Value | Source | Meaning |
| :-- | :-- | :-- |
| `ok` | sweep runner | Normal pass; the watermark advanced to `H` (possibly a 0-Story progress advance, or a no-op when `H IS NULL` or `H ≤ wm`). |
| `skipped` | sweep runner | The per-customer advisory lock was held by a concurrent sweep — normal "nothing to do". |
| `failed` | sweep runner | The sweep transaction rolled back; `error` populated. |
| `timeout` | dispatcher | The customer's sweep exceeded its effective timeout. The dispatcher aborted the runner and Postgres cancelled the in-flight statement; the transaction rolled back. |
| `skipped-timeout` | dispatcher | The total dispatcher timeout fired before this customer was attempted; the next hourly tick picks them up via the watermark. |

`overall` is derived deterministically:

- `ok` ⇔ every per-customer status is `ok` or `skipped` (a normal skip
  is part of the steady state, not a failure).
- `partial` ⇔ at least one per-customer status is `failed`, `timeout`,
  or `skipped-timeout`, and the dispatcher itself completed. **Still
  HTTP 200.**
- `failed` (HTTP 500) ⇔ the dispatcher itself failed before fan-out
  (e.g. the customer-enumeration query errored). The body is
  `{ "overall": "failed", "error": <message>, "perCustomer": [] }`.

A single customer's failure does not abort the others — the dispatcher
reports `partial` and continues.

## Concurrency

Each sweep takes a per-customer transaction-scoped advisory lock in its
own namespace, distinct from the cadence's:

```sql
pg_try_advisory_xact_lock(hashtext('triage_lowslow_sweep:' || customer_id))
```

The sweep does **not** share the cadence's writer lock: correctness
does not require it because `H` is bounded by the cadence's published,
monotonic watermark, so a sweep and a cadence pass for the same
customer are correct to run concurrently. If the lock is unavailable
(another sweep is mid-flight) the runner returns `status: 'skipped'`
and the next hourly tick picks up via the watermark. Lock release is
automatic on commit/rollback because the lock is transaction-scoped.

## Watermark behavior

The sweep's forward-progress marker is
`baseline_corpus_state.lowslow_finalized_through` (`wm`), separate from
the cadence's `story_finalized_through`. Its semantics differ from the
cadence's `last_event_cursor` in three ways operators should know:

- **Bounded by the cadence.** The finalization range is `(wm, H]` where
  `H = story_finalized_through`. When the cadence has not progressed
  (`H ≤ wm`) the sweep early-returns before the 24-hour member-scan —
  the range is empty and the advance would be a no-op anyway. This
  stops the hourly cron from re-reading the same window while the
  cadence is idle.
- **First-run policy — latest window only, no backfill.** On the very
  first run for a customer (`wm IS NULL`) **both** the member-scan and
  the finalization range are clamped to the most recent window
  (`(H − 24h, H]`). The sweep does **not** backfill the full 180-day
  corpus. This intentionally differs from the cadence's first-tick
  rule, which degenerates its range to `(-∞, H]`.
- **Advances even on zero-result runs.** `lowslow_finalized_through` is
  a *progress* watermark, not a Stories-produced one: it advances to
  `H` even when a tick inserts no Stories, and it is kept monotonic via
  `GREATEST(lowslow_finalized_through, H)`.

### Rebuild interaction

The low-and-slow rules R2 and R6 are re-derived by **neither** the
baseline force-rebuild (which re-derives no Stories) **nor** the
[Story force-rebuild](triage-story-rebuild.md) (which re-derives the
cadence-path rules R1/R3/R4/R5). The sweep and
`lowslow_finalized_through` are intentionally not wired into either
rebuild path, consistent with the no-retroactive-backfill contract:
once the watermark has passed a window, that window is not re-swept.

## Runbook — schedule the sweep

**The `cron` service in `docker-compose.yml` already wires this** — see
`infra/cron/crontab` for the entry and
`infra/cron/run-triage-lowslow-sweep.sh` for the wrapper. The cron
entry runs at minute 0 of every hour:

```text
0 * * * * /usr/local/bin/run-triage-lowslow-sweep.sh
```

A `docker compose --profile prod up -d` boot is sufficient to start the
hourly sweep; no external scheduler config is required. Like the
cadence's cron service, the `cron` container waits for `next-app` to
become healthy (`/api/health`) before firing its first tick. The
wrapper captures every response body to
`/var/log/cron/cron-lowslow-<ts>.json` inside the cron container
(persisted via the `cron-logs` named volume) and emits a one-line
summary to stdout that `docker compose logs cron` surfaces.

### Token and env allowlist

Because busybox `crond` does not propagate container env into spawned
jobs, the cron entrypoint (`infra/cron/entrypoint.sh`) materialises an
allowlisted subset of env into `/etc/cron.env`, which the wrapper
sources. Both of the sweep's env vars are in that **`ENV_ALLOWLIST`**:

- `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN` — the per-surface internal
  token.
- `LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` — passed through so the
  wrapper derives its `--max-time` from the same operator knob
  `next-app` honours. Without this passthrough an operator raising the
  dispatcher total timeout via `.env` would still be killed by the
  wrapper's default cap.

Provisioning checklist:

1. Provision a strong random token for
   `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN`. Store it in your secrets
   manager, rotate on a normal cadence, never check it in. It must be
   distinct from the cadence token.
2. Set the env var in `.env` (the `cron` service inherits the same
   `env_file: .env` as `next-app`). The route refuses every request
   when the env var is unset.
3. Verify the first scheduled run via `docker compose logs cron` and
   tail the timestamped response body under `/var/log/cron/`.

Operators running outside the bundled compose may hit the same route
from any external scheduler — **every hour** (the route fans out
per-customer internally):

```bash
curl -sS -o /tmp/lowslow.json -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 3300 \
  -X POST \
  -H "Authorization: Bearer $TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '' \
  "$BFF_BASE_URL/api/internal/triage/baseline/lowslow-sweep"
```

Keep `--max-time` at-or-above the dispatcher total timeout
(`LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS`, default 3300000 ms = 3300 s
= 55 min) and strictly below the 60-minute (3600 s) cron interval, so
the application-level timeout — which produces the structured `timeout`
/ `skipped-timeout` rows — wins over the network-level timeout (which
surfaces as a transport failure with no body) and successive ticks
cannot overlap. The bundled cron wrapper derives `--max-time` from
`LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` automatically (ms → s,
rounded up, capped at 3300 s), so the two stay in sync as long as both
are set in the same `.env`. External schedulers must update their cap
manually whenever the dispatcher knob is retuned.

## Monitoring

`200 / overall: 'partial'` is HTTP-success — a naive `curl -fsS` would
treat it as fine. To prevent silent partial failures from accumulating,
**alert on `overall != 'ok'`**. There are two keying surfaces:

1. The dispatcher emits one structured `console.log` line per
   invocation tagged `triage_lowslow_sweep_dispatch` carrying
   `overall`, the per-customer status counts (`ok`, `skipped`,
   `failed`, `timeout`, `skippedTimeout`), `totalCustomers`, and the
   per-customer entries. This is the canonical line; key your alerting
   on it. The same line is emitted on dispatcher self-failure with
   `overall: 'failed'`, an empty `perCustomer`, all counters at 0, and
   an `error` field — so a single rule on `overall != 'ok'` catches
   both partial and self-failure cases.
2. The cron wrapper (`run-triage-lowslow-sweep.sh`) re-emits a
   human-readable warning to stderr on `overall != 'ok'`, listing the
   offending `customerId:status` pairs, which surfaces in
   `docker compose logs cron`.

The wrapper intentionally exits 0 on HTTP 200 regardless of `overall`
(the next hourly tick re-runs and confirms whether the issue persists),
so cron's MAILTO does not double-page — alerting on the structured log
line is the recovery path. Transport failures and HTTP 401/403 (auth
misconfiguration) do exit non-zero, since those are operator errors
that need immediate attention.

## Observability

A completed sweep updates `baseline_corpus_state.lowslow_finalized_through`
to `H` (kept monotonic via `GREATEST`), even on a 0-Story tick.
Operators can sample this column directly to confirm the sweep is
advancing without polling the route every tick: a
`lowslow_finalized_through` that stops advancing while
`story_finalized_through` keeps moving is the signal that the sweep is
stuck or failing.
</content>
</invoke>
