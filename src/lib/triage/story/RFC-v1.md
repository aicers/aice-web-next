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

Four rules ship under `story_version = 'v1'`: the original asset-keyed
R1/R3, plus the multi-source R4 (fan-in) and R5 (campaign) added by
issue #694. R2 (kill-chain progression) is intentionally deferred to a
v2 RFC bump; the `correlation_rule_id = 'R2'` slot stays reserved so
the rule-ID enum does not shift.

R4 and R5 treat events as "the same attack" using the conservative v1
identity — **same critical `category` AND overlapping critical
`selector_tags`** (mirrors R1's category predicate + R3's selector
predicate). Both additionally exclude `orig_addr IS NULL` and
`resp_addr IS NULL`: R4 keys on the victim, and R5's distinct-victim
floor cannot attribute a null-victim event, so a null-victim member
contributes to neither rule's victim accounting and is dropped from
candidacy entirely.

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
- **SQL push-down (§5).** R1's per-page candidate read in
  `repository.ts` is:

  ```sql
  SELECT … FROM baseline_triaged_event
   WHERE event_time IN [memberScanStart, memberScanEnd]
     AND orig_addr IS NOT NULL
     AND category = ANY($criticalCategories::text[])
  ```

  Same-asset narrowing (10-minute window per `orig_addr`) is a
  clustering operation across the returned rows and lives in the
  rule layer (`rules.ts` `clusterByWindow` + `groupByAsset`), not
  the SQL — same-asset clustering is what produces the cluster
  boundaries the rule scores against. The issue's measurement
  gate runs `EXPLAIN ANALYZE` against the SQL above.

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
- **SQL push-down (§5).** R3's per-page candidate read in
  `repository.ts` is two-phase. Phase 1 pre-aggregates candidate
  assets:

  ```sql
  SELECT host(orig_addr) AS orig_addr
    FROM baseline_triaged_event
   WHERE event_time IN [memberScanStart, memberScanEnd]
     AND orig_addr IS NOT NULL
     AND selector_tags && $criticalSelectors::text[]
   GROUP BY orig_addr
  HAVING COUNT(*) >= 3
  ```

  Phase 2 is the per-asset row read — the shape the issue's
  measurement gate names ("R3 same-asset-1h scan"):

  ```sql
  SELECT … FROM baseline_triaged_event
   WHERE event_time IN [memberScanStart, memberScanEnd]
     AND orig_addr = ANY($assets::inet[])
     AND selector_tags && $criticalSelectors::text[]
  ```

  The `orig_addr = ANY(…)` predicate is what the planner uses to
  resolve per-asset narrowing through
  `baseline_triaged_event_orig_addr_gist`
  (`gist_inet_ops` supports `=`), and what
  `EXPLAIN ANALYZE` validates against the GiST path. Phase 1's
  `HAVING COUNT(*) >= 3` matches R3's per-rule member threshold,
  so assets that cannot reach the threshold in the scan range are
  dropped before phase 2 reads them. Final sliding-window
  clustering remains a rule-layer operation across phase 2's
  returned rows — the SQL only narrows *which* assets are read,
  not how their events cluster. If measurement at scale shows the
  planner cannot resolve `selector_tags &&` efficiently on
  `baseline_triaged_event`, the additive follow-up named in the
  issue is a GIN index on `selector_tags` — migration-only, no
  callsite churn.

### R4 — Fan-in (converging on one victim)

> Within a **1-hour** window, **≥ `R4_MIN_SOURCES` distinct
> `orig_addr`** target the **same `resp_addr`** with the **same
> critical `category`**, all members satisfying the critical-selector
> predicate.

- Window: **1 hour** (sliding; same `clusterByWindow` semantics as R3).
- Grouping key: `(resp_addr, category)`.
- Threshold: `R4_MIN_SOURCES = 3` distinct source IPs (calibration
  knob).
- `primary_asset = resp_addr` (the victim — fits the existing `INET`
  column).
- `correlation_key = host(resp_addr) || '|' || category` (dedup
  discriminator — see §5).
- Score: **distinct source-IP count** in the window.
- `correlation_rule_id = 'R4'`.
- **SQL push-down (§5).** R4's read is two-phase. Phase 1
  pre-aggregates candidate victims:

  ```sql
  SELECT host(resp_addr) AS resp_addr, category
    FROM baseline_triaged_event
   WHERE event_time IN [memberScanStart, memberScanEnd]
     AND orig_addr IS NOT NULL AND resp_addr IS NOT NULL
     AND category = ANY($criticalCategories::text[])
     AND selector_tags && $criticalSelectors::text[]
   GROUP BY resp_addr, category
  HAVING COUNT(DISTINCT orig_addr) >= $R4_MIN_SOURCES
  ```

  Phase 2 reads members for the candidate victims via
  `resp_addr = ANY($::inet[])` (riding
  `baseline_triaged_event_resp_addr_gist`). Final
  `(resp_addr, category)` grouping, sliding-window clustering, and
  the distinct-source threshold stay in `rules.ts`.

### R5 — Campaign (same signature, multiple victims)

> Within a **1-hour** window, the **same critical `category`** is
> driven by **≥ `R5_MIN_SOURCES` distinct `orig_addr`** against
> **≥ `R5_MIN_VICTIMS` distinct `resp_addr`**, all members satisfying
> the critical-selector predicate.

- Window: **1 hour**.
- Grouping key: `category` (the shared signature).
- Thresholds: `R5_MIN_SOURCES = 5` distinct sources **and**
  `R5_MIN_VICTIMS = 2` distinct victims. The `≥ 2 victims` floor is
  what distinguishes a campaign from an R4 fan-in.
- `primary_asset = NULL` (no single converging asset).
- `correlation_key = category`.
- Score: **distinct source-IP count** in the window.
- `correlation_rule_id = 'R5'`.
- **SQL push-down (§5).** Phase 1 pre-aggregates candidate
  signatures:

  ```sql
  SELECT category
    FROM baseline_triaged_event
   WHERE event_time IN [memberScanStart, memberScanEnd]
     AND orig_addr IS NOT NULL AND resp_addr IS NOT NULL
     AND category = ANY($criticalCategories::text[])
     AND selector_tags && $criticalSelectors::text[]
   GROUP BY category
  HAVING COUNT(DISTINCT orig_addr) >= $R5_MIN_SOURCES
     AND COUNT(DISTINCT resp_addr) >= $R5_MIN_VICTIMS
  ```

  The `COUNT(DISTINCT resp_addr)` clause enforces the ≥2-victims
  floor. Phase 2 reads members for the candidate categories via
  `category = ANY($::text[])`. Per §9 (option A), a large attack may
  legitimately produce both an R4 row (per victim) and an R5 row
  (campaign-wide); that is intended and not deduplicated at write
  time.

### `max_rule_window`

`max_rule_window = max(R1.window, R3.window, R4.window, R5.window)
= 1 hour`. R4/R5 share R3's 1-hour window, so adding them does not
move it. Consumed by the §4 slop-replay member-scan lookback. Adding
any rule with a larger window forces a Story RFC bump because the
slop-replay window grows with it.

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
  `(-∞, new_horizon]` — no event-time lower bound is applied.
  `corpus_activated_at` is intentionally NOT used as an
  event-time floor (wall-clock anchor for §7 active-window age,
  not an event-time marker; using it here would mis-bound a
  historical catch-up). The page's own `event_time.min` is also
  NOT used as a floor: a tenant that already has
  `baseline_triaged_event` rows when migration 0008 lands carries
  rows that sit before this page's min — those rows must be
  candidates on the first tick or they would never be considered
  for finalization again after the watermark advances past them.
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
the original schema (single new file). The only `ALTER` on existing
tables is the additive `story_finalized_through` column on the
`baseline_corpus_state` singleton; corpus A tables
(`baseline_triaged_event`, `observed_event_meta`) are not touched.

### `correlation_key` column and dedup re-scope (issue #694)

Migration `migrations/customer/0024_event_group_correlation_key.sql`
adds the multi-source rules' persistence:

- `ALTER TABLE event_group ADD COLUMN correlation_key TEXT;`
  (additive, nullable).
- New partial unique index governing R4/R5:

  ```sql
  CREATE UNIQUE INDEX event_group_corrkey_dedup_idx ON event_group
    (correlation_rule_id, correlation_key, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND correlation_key IS NOT NULL;
  ```

- **Re-scope of the existing index** so an R4 row (which sets BOTH
  `primary_asset` and `correlation_key`) is governed solely by the
  new index. Without this, two same-victim/same-window R4 rows
  differing only by `category` would collide on
  `(R4, resp_addr, window)` and the old index would raise an
  unhandled `unique_violation` (`ON CONFLICT` only arbitrates the
  named `correlation_key` index). The fix narrows the old index with
  `AND correlation_key IS NULL` (DROP + CREATE, no data change):

  ```sql
  DROP INDEX IF EXISTS event_group_auto_dedup_idx;
  CREATE UNIQUE INDEX event_group_auto_dedup_idx ON event_group
    (correlation_rule_id, primary_asset, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL
      AND correlation_key IS NULL;
  ```

  This partitions cleanly by `correlation_key` NULL-ness: R1/R3
  (`correlation_key IS NULL`) on the old index, R4/R5
  (`correlation_key IS NOT NULL`) on the new one. The migration is
  therefore **not purely additive** (it re-scopes one existing index)
  but is data-preserving — R1/R3 dedup semantics are identical.

- **`insertAutoStory` branches its `ON CONFLICT` target by whether
  `correlationKey` is present**, not by rule id, and writes
  `correlation_key` in both the plain and carry-over INSERT variants.
  When `correlationKey` is set (R4/R5) it targets
  `event_group_corrkey_dedup_idx`; when NULL (R1/R3) it keeps the
  re-scoped `event_group_auto_dedup_idx`. Both paths stay
  `… ON CONFLICT DO NOTHING`. R1/R3 always write
  `correlation_key = NULL`.

The cadence pager imports `runStepF` from
`src/lib/triage/story/correlator.ts` and calls it immediately after
`insertBaselineTriagedEventBatch`, inside the same per-page
transaction the runner already opens.

### Per-rule SQL push-down

`repository.ts` exposes one read function **per rule**, not a
single broad-range candidate scan:

- `readR1Candidates({ memberScanStart, memberScanEnd })` —
  single SELECT: `category = ANY($criticalCategories::text[])`
  plus the time range and `orig_addr IS NOT NULL`.
- `readR3Candidates({ memberScanStart, memberScanEnd })` —
  two-phase. Phase 1 pre-aggregates candidate assets
  (`GROUP BY orig_addr HAVING COUNT(*) >= 3` over the
  `selector_tags && $criticalSelectors::text[]` predicate);
  phase 2 reads per-asset rows via
  `orig_addr = ANY($assets::inet[])`.
- `readR4Candidates` / `readR5Candidates` (issue #694) — two-phase,
  reading a candidate set that also carries `resp_addr`. R4 phase 1
  groups by `(resp_addr, category)`, R5 phase 1 by `category` with a
  distinct-victim floor; phase 2 reads members for the candidate
  keys (`resp_addr = ANY(…)` for R4, `category = ANY(…)` for R5).

The correlator runs all four reads in parallel, then dispatches each
result set to its rule's pure in-memory clusterer. The split
serves three goals:

1. **Measurement gate is meaningful.** The issue's measurement
   gate demands `EXPLAIN ANALYZE` on R3's same-asset-1h scan,
   confirming `(event_time DESC)` and the `orig_addr` GiST index
   participate in the plan. The phase-2 SELECT's
   `orig_addr = ANY(...)` is the predicate that resolves through
   `baseline_triaged_event_orig_addr_gist`
   (`gist_inet_ops` supports `=`), so the gate has a concrete
   production-shape target.
2. **App-side memory bound.** A typical-volume tenant produces a
   large number of `baseline_triaged_event` rows in the slop-
   replay range; predicate-pushed reads cap the in-memory set at
   the rows R1/R3 actually evaluate, instead of materializing the
   full range and filtering in app memory inside the per-page
   transaction. Phase 1's `HAVING COUNT(*) >= 3` further drops
   assets that cannot reach R3's member threshold before phase 2
   reads any of their rows.
3. **Rule-layer separation stays clean.** Final sliding-window
   clustering (the 10-min / 1-hour per-`orig_addr` window) is the
   shape the rule scores against; that stays in `rules.ts`
   (`groupByAsset` + `clusterByWindow`). The SQL only narrows
   which rows the rule evaluates — phase 1's `COUNT(*) >= 3` is
   the rule's member-count threshold in the scan range, not the
   sliding window itself, so a candidate that phase 1 admits may
   still fail the in-memory window check, and that is the
   intended behaviour.

### Analyst-curated path

`src/lib/triage/story/repository.ts` exports `insertCuratedStory`
for the "Save as Story" mutation #490 ships. The shape mirrors
`insertAutoStory` with three differences:

- `kind = 'analyst_curated'`.
- `correlation_rule_id = NULL` (curated rows have no rule).
- No `ON CONFLICT` clause — the partial unique index is scoped to
  `kind = 'auto_correlated'`, so a curated save can legitimately
  repeat a `(asset, window)` an analyst already stored.

The same §7 `summary_payload` contract and §8 member cap /
sampling order apply, so curated rows are interchangeable with
auto-correlated rows from the LLM's perspective.

## §6 — `story_version`

Initial value: **`'v1'`**. Mirrors `baseline_version` and follows
the same natural-expiry model: a Story RFC bump produces new
groups under the new version; old-version groups age out via
retention without retroactive recomputation.

The R4/R5 multi-source rules (issue #694) keep the `story_version`
stamp at **`'v1'`**: they are additive new `correlation_rule_id`
values that do not invalidate existing v1 rows, so no version bump is
warranted. Mixing R1/R3/R4/R5 rows under one `'v1'` cohort is
intentional — score comparisons remain within-cohort by
construction (§2).

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
| `distinctAssetCount` | `number`                   | Distinct non-NULL `orig_addr` across members. For the asset-keyed rules R1/R3 this is typically `1`; for the multi-source rules R4/R5 (issue #694) it legitimately exceeds 1 and is the meaningful source fan-out figure. |
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

A future rule that reads the **same shared candidate set** as R1/R3
plugs into the runner as a typed predicate function plus metadata in
`src/lib/triage/story/rules.ts`'s `RULE_REGISTRY`.

**Amendment (issue #694, option (a)).** R4/R5 do *not* fit the
`RULE_REGISTRY` shared-set signature: `RULE_REGISTRY` entries are
`(events) => StoryDraft[]` over one shared candidate set, whereas
R4/R5 need their own predicate-pushed reads
(`readR4Candidates` / `readR5Candidates`, which select `resp_addr`
and pre-aggregate on different keys). So R4/R5 are **wired directly
in the correlator** (`correlator.ts` `runStoryCorrelationForWindow`),
alongside their reads, and `RULE_REGISTRY` / `detectAllStories`
deliberately list only R1/R3. A future rule that needs its own
candidate source follows the R4/R5 precedent (direct correlator
wiring); one that can share the R1/R3 candidate set joins
`RULE_REGISTRY`. Either way no schema change is required.

v2 R2 specifically must specify its data source — cadence-side
`payload_summary` extension, or new normalized columns on
`baseline_triaged_event`, or both — before merging. The
`correlation_rule_id = 'R2'` slot is reserved by this RFC for that
bump.

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

### Example 4 — R4 fan-in (issue #694)

Three distinct source IPs hit victim `10.0.0.100` with the same
critical category `IMPACT`, each carrying a critical selector, within
50 minutes:

| event_key | event_time                | orig_addr | resp_addr   | category | selector_tags   |
|-----------|---------------------------|-----------|-------------|----------|-----------------|
| 1         | 2026-05-09 10:00:00 +0000 | `10.1.0.1`| `10.0.0.100`| `IMPACT` | `['S2-severe']` |
| 2         | 2026-05-09 10:20:00 +0000 | `10.1.0.2`| `10.0.0.100`| `IMPACT` | `['S2-severe']` |
| 3         | 2026-05-09 10:50:00 +0000 | `10.1.0.3`| `10.0.0.100`| `IMPACT` | `['S2-severe']` |

- The `(resp_addr, category) = ('10.0.0.100', 'IMPACT')` bucket has
  3 distinct `orig_addr` ≥ `R4_MIN_SOURCES` within 1 hour. R4 fires.
- R5 does not: a single victim cannot meet the `≥ 2 victims` floor.

Result: one `event_group` row with `correlation_rule_id = 'R4'`,
`primary_asset = '10.0.0.100'`,
`correlation_key = '10.0.0.100|IMPACT'`, `score = 3` (distinct
source count), `time_window_start = 10:00:00`,
`time_window_end = 10:50:00`, `summary_payload.distinctAssetCount =
3`.

### Example 5 — R5 campaign (issue #694)

The same critical category `IMPACT` is driven by five distinct
source IPs against three victims within 40 minutes:

| event_key | event_time                | orig_addr | resp_addr   | category | selector_tags   |
|-----------|---------------------------|-----------|-------------|----------|-----------------|
| 1         | 2026-05-09 10:00:00 +0000 | `10.1.0.1`| `10.0.0.100`| `IMPACT` | `['S2-severe']` |
| 2         | 2026-05-09 10:10:00 +0000 | `10.1.0.2`| `10.0.0.100`| `IMPACT` | `['S2-severe']` |
| 3         | 2026-05-09 10:20:00 +0000 | `10.1.0.3`| `10.0.0.200`| `IMPACT` | `['S2-severe']` |
| 4         | 2026-05-09 10:30:00 +0000 | `10.1.0.4`| `10.0.0.200`| `IMPACT` | `['S2-severe']` |
| 5         | 2026-05-09 10:40:00 +0000 | `10.1.0.5`| `10.0.0.30` | `IMPACT` | `['S2-severe']` |

- The `category = 'IMPACT'` bucket has 5 distinct `orig_addr` ≥
  `R5_MIN_SOURCES` and 3 distinct `resp_addr` ≥ `R5_MIN_VICTIMS`
  within 1 hour. R5 fires.
- No single victim has ≥ 3 sources, so R4 does not fire here. (Had
  one victim met R4's threshold, option A would legitimately emit
  both an R4 row and this R5 row.)

Result: one `event_group` row with `correlation_rule_id = 'R5'`,
`primary_asset = NULL`, `correlation_key = 'IMPACT'`, `score = 5`
(distinct source count), `time_window_start = 10:00:00`,
`time_window_end = 10:40:00`, `summary_payload.distinctAssetCount =
5`.

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
