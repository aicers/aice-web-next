# Triage Story Rebuild

The Triage menu's Story tab reads from per-customer
`event_group` / `event_group_member` rows that the heuristic Story
correlator produces inside the cadence pipeline. The cadence path
owns forward progress (the `story_finalized_through` watermark), so
Stories only appear once their finalization window has closed and a
new ingestion page advances the watermark past them.

This admin-triggered route re-runs the correlator for an already-
finalized `[from, to)` window without disturbing the watermark.
It is the dedicated Story side-channel for the cases where the
on-disk `event_group` rows are stale relative to the current corpus
or the current rule code.

## When to use it

Two operational situations require a Story rebuild:

1. **After a baseline rebuild on the same window.** The baseline
   rebuild (`POST /api/triage/baseline/rebuild`) explicitly
   disables the Story correlator on its rebuild path — cadence owns
   the Story finalization watermark, and reinvoking the correlator
   from inside a window-scoped baseline rebuild would mix two
   responsibilities. As a consequence the `event_group` rows that
   sit on top of the rebuilt window reference a corpus A that no
   longer exists. Follow up every baseline rebuild with a Story
   rebuild on the same `[from, to)` window to keep the two corpora
   consistent.
2. **After a Story correlation-rule change.** Changes to
   `STORY_VERSION`, `CRITICAL_CATEGORIES`, or `CRITICAL_SELECTOR_SET`
   only affect Stories produced going forward via cadence. Run a
   Story rebuild on the affected window so the on-disk rows reflect
   the current rule code.

## Endpoint

```text
POST /api/internal/triage/story/rebuild
Authorization: Bearer <TRIAGE_STORY_REBUILD_INTERNAL_TOKEN>
Content-Type: application/json

{
  "customer_id": 42,
  "from": "2026-05-01T00:00:00Z",
  "to":   "2026-05-08T00:00:00Z"
}
```

The token is read from `TRIAGE_STORY_REBUILD_INTERNAL_TOKEN`. The
route refuses every request when the env var is unset, and it
constant-time compares the provided value against the env value to
avoid a timing oracle. The shared secret should be a fresh, strong
random token — never reuse the cadence or fanout tokens.

`from` and `to` are ISO-8601 timestamps interpreted as a half-open
range `[from, to)` against `event_group.time_window_end`. Auto
Stories whose `time_window_end` satisfies
`time_window_end >= from AND time_window_end < to` are DELETEd and
recomputed; rows on the exact boundary `time_window_end == to` are
left untouched. Member-scan reads cover a wider range,
`[from − MAX_RULE_WINDOW_MS, to)`, so cross-window clusters whose
end falls just past `from` can still pick up earlier members.

## Response

A successful call returns HTTP 200 with the per-run counters:

```json
{
  "deletedAutoStories":    4,
  "insertedAutoStories":   5,
  "skippedCuratedStories": 2,
  "betaCarriedOver":       3,
  "durationMs":            142,
  "warnings": []
}
```

| Field | Meaning |
| :-- | :-- |
| `deletedAutoStories` | Auto Stories (`kind = 'auto_correlated'`) removed from the window. Their member rows follow via `ON DELETE CASCADE` on `event_group_member.event_group_id`. |
| `insertedAutoStories` | Auto Stories the post-DELETE correlator pass INSERTed. |
| `skippedCuratedStories` | Analyst-curated Stories (`kind = 'analyst_curated'`) whose `time_window_end` fell inside the window and were intentionally left untouched. Curated rows are explicit human input and stay untouched. |
| `betaCarriedOver` | Newly-inserted auto Stories whose β columns (`last_sent_at`, `send_count`, `last_sent_by`) were copied from a matching pre-rebuild row, so the operator's "already-analyzed" awareness persists across a rules-changed recompute. |
| `durationMs` | End-to-end wall-clock duration of the rebuild call. |
| `warnings` | Non-fatal warnings; reserved. |

Status codes other than 200:

| Status | Meaning |
| :-- | :-- |
| 400 | Malformed JSON, missing / non-positive `customer_id`, or an empty / inverted range. |
| 401 | Bearer token missing or does not match. |
| 404 | The supplied `customer_id` does not map to an active customer. |
| 409 | The per-customer advisory lock is held by cadence, a baseline rebuild, exclusion-ADD, or another Story rebuild. Retry once the holder releases the lock. |
| 500 | The rebuild rolled back. The pre-rebuild `event_group` rows are preserved because DELETE and INSERT share one atomic transaction. |

## Concurrency

The rebuild takes a per-customer **session-level** advisory lock on
the byte-identical key cadence, exclusion-ADD, and the baseline
rebuild use:

```sql
pg_try_advisory_lock(hashtext('triage_baseline_cadence:' || customer_id))
```

Session scope is required because the rebuild spans multiple SQL
statements outside any single transaction (snapshot read → DELETE
→ correlator → INSERT). The lock is released in a `finally` block
regardless of outcome.

While the lock is held:

- A cadence tick for the same customer takes
  `pg_try_advisory_xact_lock` on the same key inside its per-page
  transaction. It sees the rebuild's session lock, the
  `pg_try_advisory_xact_lock` returns `false`, and the page rolls
  back cleanly. The next scheduled tick picks up where the previous
  page left off.
- A second Story rebuild for the same customer returns HTTP 409
  immediately. The route does not queue or retry.
- A baseline rebuild for the same customer fails its own
  `pg_try_advisory_lock` and surfaces `RebuildBusy`.

## β tracking carry-over

When a rebuilt auto Story matches an old auto Story by the natural
key `(correlation_rule_id, primary_asset, time_window_start,
time_window_end)`, the β submission-tracking columns
(`last_sent_at`, `send_count`, `last_sent_by`) are copied from the
old row. Stories with no natural-key match get the column DEFAULTs
(NULL / 0 / NULL).

This matches the most common rebuild trigger — "rules changed,
recompute" — where, within the same window, asset, and rule, the
new Story represents the same analytical unit and the operator's
"already analyzed" awareness should persist. The Clumit Insight intake
contract (#492) already exposes `force_refresh: true` as the
explicit escape hatch for operators who want to re-analyze when
content has materially changed.

The natural key matches the partial unique index on `event_group`
(`(rule, asset, start, end) WHERE kind = 'auto_correlated' AND
primary_asset IS NOT NULL`), so curated Stories are excluded from
carry-over by construction.

## Cascading with the baseline rebuild

The two routes are deliberately decoupled — the Story rebuild does
not chain automatically off the baseline rebuild. After an operator
rebuilds baseline for a window via
`POST /api/triage/baseline/rebuild`, follow up with a
Story rebuild on the same `[from, to)` to keep `event_group`
consistent with the new corpus A.

Recommended runbook order:

1. POST `/api/triage/baseline/rebuild` (session-authenticated,
   `SystemAdministrator` role, body uses camelCase `customerId` /
   `from` / `to`) with the desired window. Wait for the HTTP 200
   response carrying `deletedTriagedRows` /
   `insertedTriagedRows` / `durationMs` (or a typed `code` error).
2. POST `/api/internal/triage/story/rebuild` (internal-token route,
   body uses snake_case `customer_id`) with the same `customer_id`
   matching step 1's `customerId`, and the same `from` / `to`. Wait
   for a 200 response.

Both routes contend on the same advisory key, so the second call
either completes cleanly (when the first has released) or returns
409 if a cadence tick or exclusion-ADD slipped in between.

## Watermark invariant

A rebuild call **does not** read or advance
`baseline_corpus_state.story_finalized_through`. The watermark is
cadence's marker for forward progress; rewriting it on a
window-bounded rebuild would shift the cadence-side finalization
boundary and risk re-finalizing events the next tick would
otherwise skip. The extraction of `runStoryCorrelationForWindow`
from the cadence-side `runStepF` enforces this by construction —
the rebuild path calls the pure correlator core directly and never
touches the watermark column.

## Out of scope

- **Audit log entry.** No audit row is written. This matches the
  internal-token route family (cleanup, cadence, dispatch, fanout)
  which run as system actors. When the follow-up admin-UI surface
  is added, that follow-up owns the audit-action addition.
- **Clumit Insight push side effects.** A Story rebuild does not
  notify Clumit Insight that a previously-sent Story has been
  replaced; that policy is part of the broader Triage/Story Clumit
  Insight push design (umbrella #491) and considered uniformly across
  Triage and Story.
- **Curated Story regeneration / editing.** Curated Stories are
  explicit human input and stay untouched.
- **Admin UI surface.** This issue ships the internal-token route
  only. The UI surface (if any) is a follow-up; that follow-up
  also owns the corresponding audit-action addition.
- **Cross-customer batch.** One `customer_id` per call; the
  deployment scheduler or operator iterates if multiple tenants
  need rebuilding.
