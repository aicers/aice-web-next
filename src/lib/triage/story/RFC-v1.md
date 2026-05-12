# Story RFC v1

Status: draft (lands with issue #489 / 1B-Story-1).
Owners: triage + corpus working group.

## §1 — Purpose

Add the **Story** concept on top of corpus A: a small, deterministic
bundle of correlated `baseline_triaged_event` rows produced by the
cadence's step (f) heuristic correlator. The grouping is **always
heuristic in v1** — LLM-driven grouping is the Phase 2 umbrella's
concern, downstream of this layer. The Stories UI ships in #490.

The user-facing label is **Story**. The internal/DB names are
`event_group` (container) and `event_group_member` (rows).

## §2 — Score model

Story rules predicate on `selector_tags` membership and on the row's
own `category` column, never on `baseline_score` (which does not
exist on the row at cadence time — it is read-time-computed via
`cume_dist()` per `(kind, baseline_version)`) and never on
`raw_score` (whose absolute scale shifts across `baseline_version`
bumps). `selector_tags` is RFC 0001 §9's stable, enumerated emission
and survives §9 retunes that change weights but not the tag set.

The Story-side aggregate `score` on `event_group` is a per-rule
count or weighted count over `selector_tags` matches — never a
function of `raw_score`. Cross-Story sort by `score` therefore
compares within the same `story_version` cohort by construction.

## §3 — Rule definitions and parameters

Two rules ship in v1. R2 (kill-chain progression) is intentionally
deferred to a v2 RFC bump; the `correlation_rule_id = 'R2'` slot
stays reserved so the rule-ID enum does not shift.

### R1 — Asset × multi-category window

> Same `primary_asset` (orig_addr), within a 10-minute window, has
> events from ≥2 distinct categories in the critical-category set.

- Window: **10 minutes**.
- Critical-category set: `CRITICAL_CATEGORIES` from
  `src/lib/triage/baseline/categories.ts` —
  `{COMMAND_AND_CONTROL, CREDENTIAL_ACCESS, EXFILTRATION, IMPACT,
  INITIAL_ACCESS}`.
- Membership read directly from
  `baseline_triaged_event.category` — no `selector_tags` lookup
  needed.
- Predicate excludes events with `orig_addr IS NULL`.
- Score: `member_count + λ · distinct_category_count`,
  with `λ = 1.0`.
- `correlation_rule_id = 'R1'`.

### R3 — Repeated critical-selector activity on same asset

> Same `primary_asset` has ≥3 events whose `selector_tags` overlap
> the critical-selector set within a 1-hour window.

- Window: **1 hour**.
- Critical-selector set: **`{'S2-severe', 'unlabeled-cluster'}`** —
  the literal strings emitted by
  `src/lib/triage/baseline/selectors.ts` via `SELECTOR_TAGS` in
  `src/lib/triage/baseline/tunables.ts`. The full §9 emission set
  is `S1-high`, `S2-severe`, `S3-recurring`, `S4-correlated`,
  `unlabeled-cluster`; v1 takes the two whose semantics map to
  "critical-class" rather than "frequency/correlation pattern".
- Predicate: `selector_tags && ARRAY[<critical_selector_set>]::TEXT[]`
  (PostgreSQL array overlap), evaluated against
  `baseline_triaged_event`.
- Predicate excludes events with `orig_addr IS NULL`.
- Score: `member_count` (after the §8 member cap).
- `correlation_rule_id = 'R3'`.

### `max_rule_window`

`max_rule_window = max(R1.window, R3.window) = 1 hour`. Consumed
by the §4 slop-replay member-scan lookback. Adding any rule with a
larger window forces a Story RFC bump because the slop-replay
window grows with it.

## §4 — Slop window and watermark protocol

- Slop window length: **30 minutes** (default). The slop is chosen
  against the rule-firing latency analysts will tolerate, not the
  rule window itself; longer values over-defer.
- Each page commits its own corpus rows immediately (steps d/e).
- Step (f) does NOT finalize Stories whose `time_window_end`
  falls within the last `SLOP_WINDOW_MS` of the page's
  `event_time` range. Those drafts are simply skipped — no side
  table, no in-memory carry-over.
- On every successful step (f) the per-page transaction updates
  `baseline_corpus_state.story_finalized_through` to
  `(page_max_event_time − slop)`.
- The next tick reads the previous watermark and runs step (f)
  against two distinct ranges:
  - **Finalization-candidate range** (`time_window_end` allowed):
    `(previous_watermark, new_horizon]`.
  - **Member-scan range** (events read from
    `baseline_triaged_event` to populate predicates):
    `[previous_watermark − max_rule_window, new_horizon]`. The
    lookback prevents an R3 cluster whose `time_window_end` falls
    just past the previous watermark from missing members that
    sit before the watermark but inside the rule window.
- **First-tick / NULL watermark.** When
  `story_finalized_through IS NULL`, both ranges degenerate to
  `(-∞, new_horizon]`. The lower bound is the page's own
  `event_time.min` (by construction the earliest event this
  customer has produced for this page). `corpus_activated_at` is
  intentionally NOT used as an event-time floor: it is a
  wall-clock anchor for §7 active-window age, not an event-time
  marker; using it here would mis-bound a historical catch-up.
- **Empty page (zero `baseline_triaged_event` survivors).** Step
  (f) is a no-op and `story_finalized_through` is NOT advanced.
  The next non-empty page resumes from the previously-held
  watermark; the per-page `last_event_cursor` continues to
  advance independently.
- The watermark UPDATE uses `GREATEST(story_finalized_through, $1)`
  so a slop replay or a retried page cannot push the watermark
  backwards.
- Idempotency: re-evaluation can re-derive a
  `(correlation_rule_id, primary_asset, time_window_start,
  time_window_end)` tuple that step (f) already produced. The
  partial unique index plus `INSERT … ON CONFLICT DO NOTHING` on
  `event_group` is the dedup mechanism. Members upsert into
  `event_group_member` via the existing composite PK.

## §5 — Persistence

Migration `migrations/customer/0008_event_group_story.sql` lands
the schema (single new file). The only `ALTER` on existing tables
is the additive `story_finalized_through` column on the
`baseline_corpus_state` singleton; corpus A tables
(`baseline_triaged_event`, `observed_event_meta`) are not touched.

The cadence pager imports `runStepF` from
`src/lib/triage/story/correlator.ts` and calls it immediately after
`insertBaselineTriagedEventBatch`, inside the same per-page
transaction the runner already opens.

## §6 — `story_version`

Initial value: **`'v1'`**. Mirrors `baseline_version` and follows
the same natural-expiry model: a Story RFC bump produces new
groups under the new version; old-version groups age out via
retention without retroactive recomputation.

## §7 — `summary_payload` JSONB contract

Fixed key set so #490 binds to a stable shape across rule
versions. Adding a key is RFC-only; removing or renaming a key is
a `story_version` bump.

| Key                  | Type                       | Description |
|----------------------|----------------------------|-------------|
| `kindHistogram`      | `Record<string, number>`   | Per-`kind` count over members. |
| `categoryHistogram`  | `Record<string, number>`   | Per-`category` count over members; NULL categories are not bucketed. |
| `memberCount`        | `number`                   | Length of the persisted member list (post-§8 cap). |
| `durationMs`         | `number`                   | `max(event_time) − min(event_time)` across members, in ms. |
| `distinctAssetCount` | `number`                   | Distinct non-NULL `orig_addr` across members. v1 rules are asset-keyed so this is typically `1`. |
| `topRawScore`        | `number`                   | Max `raw_score` over members. Story-internal sort hint, NOT surfaced to UI as a baseline percentile. |

The correlator computes `summary_payload` at step (f) from the
member events — independent of any cadence-side `payload_summary`
extension.

## §8 — Member cap and sampling order

- `STORY_MEMBER_CAP = 50`. Matches #490's analyst-curated cap so
  the LLM context budget is consistent across creation paths.
- Sampling order when a rule matches more than 50 events in the
  same window:
  1. `cardinality(selector_tags) DESC`
  2. `event_time DESC`
  3. `event_key ASC` (final total-order tiebreaker so
     time-colliding events produce a deterministic order across
     re-evaluations).
- This is a deterministic-sampling key, **not a ranking**.
  `raw_score` is intentionally not used because members can span
  multiple `kind` / `baseline_version` cohorts where its absolute
  scale is not comparable.
- R3 in particular can saturate the cap on chatty assets; the
  50-member ceiling is what bounds R3 Story size, not the 1-hour
  window. R3's `score` reflects the admitted (post-cap) member
  count.

## §9 — Group membership when an event matches multiple rules

**Option A** — one group per rule per match. An event matching
both R1 and R3 ends up in two `event_group` rows, each carrying
exactly one `correlation_rule_id`. Stories are rule-traceable,
which makes RFC tuning measurable; merging would lose the
"show only R3 Stories" affordance and make UI sort/filter
ambiguous. The Stories UI can deduplicate by
`(primary_asset, time_window_start, time_window_end)` overlap at
render time if visual clutter is a problem.

## §10 — Future-rule format

A future rule plugs into the runner as a typed predicate function
plus metadata in `src/lib/triage/story/rules.ts`'s `RULE_REGISTRY`.
No schema change is required. v2 R2 specifically must specify its
data source — cadence-side `payload_summary` extension, or new
normalized columns on `baseline_triaged_event`, or both — before
merging. The `correlation_rule_id = 'R2'` slot is reserved by this
RFC for that bump.

## §11 — Worked examples

The three worked examples below all assume a single tenant DB at
`story_version = 'v1'`, with `slop = 30 min`, no previous
watermark, and the page's `event_time` extent covering the
relevant span.

### Example 1 — R1 fires, R3 does not

Asset `10.0.0.5` produces three events on the same page:

| event_key | event_time                | category               | selector_tags |
|-----------|---------------------------|------------------------|---------------|
| 1         | 2026-05-09 12:00:00 +0000 | `INITIAL_ACCESS`       | `[]`          |
| 2         | 2026-05-09 12:03:00 +0000 | `COMMAND_AND_CONTROL`  | `[]`          |
| 3         | 2026-05-09 12:06:00 +0000 | `COMMAND_AND_CONTROL`  | `[]`          |

- R1 sees three critical-category events on the same asset
  within 6 min ≤ 10 min, with distinct categories
  `{INITIAL_ACCESS, COMMAND_AND_CONTROL}` (cardinality 2).
  Fires. Score: `3 + 1.0 * 2 = 5.0`.
- R3 sees zero critical-selector events on this asset. Skipped.

Result: one `event_group` row with
`correlation_rule_id = 'R1'`, `primary_asset = '10.0.0.5'`,
`time_window_start = 12:00:00`, `time_window_end = 12:06:00`,
`score = 5.0`.

### Example 2 — R3 fires, R1 does not

Asset `10.0.0.7` produces three events on the same page:

| event_key | event_time                | category    | selector_tags          |
|-----------|---------------------------|-------------|------------------------|
| 10        | 2026-05-09 14:00:00 +0000 | `IMPACT`    | `['S2-severe']`        |
| 11        | 2026-05-09 14:25:00 +0000 | `IMPACT`    | `['S2-severe']`        |
| 12        | 2026-05-09 14:55:00 +0000 | `IMPACT`    | `['unlabeled-cluster']`|

- R1 sees three critical-category events but only one distinct
  category (`IMPACT`); distinct-category count `< 2`. Skipped.
- R3 sees three events overlapping the critical-selector set
  within 55 min ≤ 1 h on the same asset. Fires. Score: `3`.

Result: one `event_group` row with
`correlation_rule_id = 'R3'`, `primary_asset = '10.0.0.7'`,
`time_window_start = 14:00:00`, `time_window_end = 14:55:00`,
`score = 3`.

### Example 3 — Both R1 and R3 fire (option A produces two Stories)

Asset `10.0.0.9` produces five events on the same page:

| event_key | event_time                | category               | selector_tags          |
|-----------|---------------------------|------------------------|------------------------|
| 20        | 2026-05-09 09:00:00 +0000 | `CREDENTIAL_ACCESS`    | `['S2-severe']`        |
| 21        | 2026-05-09 09:02:00 +0000 | `COMMAND_AND_CONTROL`  | `['S2-severe']`        |
| 22        | 2026-05-09 09:09:00 +0000 | `EXFILTRATION`         | `['S2-severe']`        |
| 23        | 2026-05-09 09:30:00 +0000 | `IMPACT`               | `['unlabeled-cluster']`|
| 24        | 2026-05-09 09:55:00 +0000 | `IMPACT`               | `['S2-severe']`        |

- R1 sees `{CREDENTIAL_ACCESS, COMMAND_AND_CONTROL, EXFILTRATION}`
  inside the first 10-minute window (events 20–22). Fires with
  `member_count = 3`, `distinct_categories = 3`, `score = 6.0`.
  R1 may also produce a separate cluster for events 23–24
  inside its own 10-minute window — events 23 and 24 are
  IMPACT-only, so distinct-category count = 1 and R1 does NOT
  fire for that subcluster.
- R3 sees five critical-selector events on the asset within
  55 min ≤ 1 h. Fires with `member_count = 5`, `score = 5`.

Result: two `event_group` rows — one per rule (option A). Both
carry the same `primary_asset = '10.0.0.9'`; the R1 row's
`time_window_end = 09:09:00`, the R3 row's
`time_window_end = 09:55:00`. The Stories UI may dedupe by
overlap at render time.

## §12 — Out of scope of this RFC

- LLM-driven correlation — Phase 2 concern.
- Multi-window packaging (`role = 'context'`) — Phase 2 Y4
  (#495). v1 only writes `role = 'primary'`.
- R2 kill-chain rule — v2 Story RFC bump.
- Display-side strictness-slider exemption for Story members
  — owned by #471 and consumed by #490 / #458.
- Stories UI tab in the Triage menu — owned by #490.
- "Send to aimer-web" submission — owned by the Phase 2
  umbrella (Y2, #493). The β-style columns `last_sent_at`,
  `last_sent_by`, `send_count` on `event_group` are owned by
  this RFC; Y2 is the writer.
- Story retention / cleanup — owned by 1B-7 (#461).
- Cadence-side `baseline_triaged_event.payload_summary`
  extension — stays NULL as today; Story-side
  `event_group.summary_payload` is independent.
