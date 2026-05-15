# Strictness Slider RFC

- Status: **Draft (foundation slice)**
- Tracks: [#471](https://github.com/aicers/aice-web-next/issues/471)
- Related RFCs: [RFC 0001 — Baseline algorithm](../../../../rfcs/0001-baseline-algorithm.md)

## Summary

The Triage menu's volume is determined by the baseline algorithm
(#462) and the data; this RFC adds a discrete, user-facing strictness
slider so an analyst can dial that volume up or down at read time
without changing exclusions, policies, or the cadence threshold. The
slider is a read-time predicate against the `cume_dist`-projected
`baseline_score`, applied inside `composeMenu` (NOT in the SQL `ranked`
CTE) so the full-cohort bucket aggregates that drive quota allocation
are preserved (see §6). There is no re-ingest, no `review` round-trip,
no corpus mutation, and the shared `SELECT_MENU_COHORT_SQL` bind shape
is unchanged.

This is the **foundation slice** of #471 — it lands the stop set, the
algorithm-level cutoff threading, the server-action plumbing, and the
slider UI with persistence. Story-protected event force-union (branch
B), the multi-tenant dual-cap merge, the protected-event row marker,
and the EN/KR manual page are split into follow-up issues so this PR
remains reviewable.

## 1. Stop count and labels

Five discrete stops, ordered loose → strict in the UI:

| id      | Label    | Cutoff (`baseline_score >=`) |
| ------- | -------- | ---------------------------- |
| `all`   | All      | 0                            |
| `top80` | Top 80%  | 0.20                         |
| `top50` | Top 50%  | 0.50                         |
| `top20` | Top 20%  | 0.80                         |
| `top5`  | Top 5%   | 0.95                         |

Five stops were chosen over three or seven because:

- Three stops conflate "narrow" with "very narrow", which is the
  expensive end of the dial — analysts need finer resolution there.
- Seven stops introduces choice paralysis and visual cramping in the
  slider chip row. Five fits in the asset list header without
  wrapping at the common viewport widths.
- The percentile labels read consistently in both EN and KR
  (`Top 5% / 상위 5%`, etc.).

## 2. Percentile values per stop

Cutoffs follow from the `cume_dist()` identity: stop label "Top X%"
maps to cutoff `1 - X/100`. The stop spacing is geometric on the
strict end (`5% → 20%`) and linear on the loose end (`50% → 80%`)
because the strict end is where one extra row of context matters most
to the analyst, while the loose end is dominated by the per-bucket
quota anyway (see §6).

## 3. Default stop position

`top50` — the middle stop. This is the recommended starting point for
a first-time analyst:

- "Top 50%" reads as a reasonable mental model ("show me the half of
  the corpus that ranks highest"), without committing the analyst to
  an aggressive cutoff before they have context for the window.
- Same volume order-of-magnitude as the production default
  (`DEFAULT_MENU_CUTOFF = 0` with the existing per-bucket quota), so
  existing analysts will not see a step change in the rendered set
  size on first deploy.

The default lives in `stops.ts` as `DEFAULT_STRICTNESS_STOP_ID`.

## 4. "All" stop semantics

"All" means **no additional user-side cutoff**. The cadence threshold
floor (#456) is still in effect, and the menu SELECT retains the
per-bucket candidate cap from `read-path-sql.mjs`
(`bucket_rn <= MENU_CANDIDATES_PER_BUCKET`, currently 500). The
per-bucket `composeMenu` quota also still applies in this foundation
slice; lifting the quota at "All" is part of the follow-up that ships
the `defaultN` multiplier table (see §6).

The slider's hover tooltip must surface this so analysts understand
"All" is not a literal corpus dump.

## 5. Empty-window behavior contract

A zero-row window must render the funnel and the slider with all
counts at `0`, with no error. The bare aggregate without `GROUP BY`
in PostgreSQL always emits one row even on empty input, so the
read-time `cume_dist()` CTE collapses to zero rows and every
downstream count is `0` by construction.

Acceptance fixture: opening the menu on a window with no triaged
events shows the funnel and the slider with zero counts, no error.

## 6. Slider × `composeMenu` quota interaction

**Working choice for the foundation slice: option (a) — slider as an
additional filter ON TOP of quota.** The slider cutoff is applied
inside `composeMenu`'s per-row filter (`compose.mjs:158`), AFTER
`buildCohort` has reconstructed the full-cohort bucket aggregates from
the SQL `bucket_count` / `bucket_tag_sum` / `cohort_count` columns.
This ordering is load-bearing: applying the cutoff at the SQL level
would drop buckets whose rows all sit below the cutoff from the row
set `buildCohort` sees, silently shrinking the aggregate list and
redistributing the missing bucket's quota to surviving buckets. That
contradicts option (a)'s "cutoff on top of unchanged quota" semantics.
The quota is unchanged from its #462 / `FINAL_COUNT` curve value.

This matches the "narrow the result set" intent for the strict end of
the slider, where most analyst time is spent. The
`MIN_NONZERO_FLOOR` fallback in `composeMenu` also respects the
cutoff: when `assembled_count` falls below the floor, the fallback
returns the top-N rows by tie-breaker **from the cutoff-surviving
set only** (`compose.mjs:196-216`). If no row survives the cutoff,
the fallback returns empty rather than dipping below the user's stop —
otherwise a strict stop could still surface a sub-cutoff row and
violate the §1 stop contract.

The "loose end widens past the quota" intent (option (b)) is
documented in #471 but is deferred to a follow-up because it requires:

- a per-stop `defaultN` multiplier table reviewed by UX, and
- a "no quota" code path at the "All" stop that interacts with the
  `MIN_NONZERO_FLOOR` fallback in `composeMenu`.

Both of those land in the follow-up issue that ships branch B
(Story-protected force-union) so the protection contract and the
quota lift are reviewed together.

## 7. URL hash × SSR strategy

**Working choice: option (b) — replicate in query param.** Slider
position lives in both `?strictness=<id>` (server-readable, primary on
first render) and `#triage.strictness.stop=<id>` (preserved for
hash-link compatibility). On first SSR render, the page reads
`?strictness=` and threads the cutoff into `loadTriagePeriod`. The
client slider reconciles the URL hash after hydration; the URL hash is
the secondary source of truth for share links.

Precedence on first render:
`?strictness=` > `#triage.strictness.stop=` > `localStorage` > default.

Slider movement writes to:

- `?strictness=` via `router.replace` (replaces the history entry,
  triggers a server re-fetch).
- `#triage.strictness.stop=` in lock-step (preserves the hash key
  alongside pivot/story keys).
- `localStorage` (sticky per user account; cleared on no-strict-link
  navigation by the analyst rather than automatically).

Per-customer or per-user-account preference storage is out of scope.

## 7a. Degenerate index (`baseline_triaged_event_event_time_score_idx`)

The composite index added in
`migrations/customer/0003_baseline_corpus_a.sql:62-63`
(`event_time DESC, baseline_score DESC`) does NOT serve the slider:
`baseline_score` is NULL on every Phase 1.B row (computed at read
time via `cume_dist()` over `raw_score`), so the second column
collapses and the index degenerates to an `event_time` btree the
existing `baseline_triaged_event_event_time_idx` already covers.

Resolution is **deferred** alongside the measurement gate
(#471 Performance §2 / §5). The follow-up that ships branch B
runs `EXPLAIN ANALYZE` on a production-scale corpus and picks one
of:

- drop `baseline_triaged_event_event_time_score_idx` (no observed
  benefit over the existing `event_time` index), or
- rebuild it as `(event_time DESC, raw_score DESC)` if the
  planner can use the `raw_score` co-locality to skip-sort within
  the kind partitions.

This PR updates the migration comment so it no longer falsely
names the slider as the index's consumer, but does not change the
index itself — that requires a schema migration reviewed against
real-data `EXPLAIN ANALYZE` output.

## 8. Story-protected hard caps

**Deferred.** The branch B force-union, the
`STORY_PROTECTED_HARD_CAP` constant, and the per-tenant defense-in-
depth `LIMIT` ship in a follow-up issue together with the protected-
event row marker and the truncation-counter UX copy. The follow-up
inherits the read-path shape this PR introduces — the cutoff is
threaded into `composeMenu` (not the SQL `ranked` CTE, per §6) and
branch B is added as a parallel SELECT — no schema change.

In this foundation slice, the slider behaves as the "score-only"
filter: a low-score Story member at the strict end is hidden until the
follow-up lands. The acceptance fixtures in #471 that depend on
branch B (the 0.30 Story member at Top 5%) will fail in this slice by
design and pass after the follow-up.

## 9. UX review sign-off

UX review is **pending** for the foundation slice. The slider's
discrete five-stop layout, label copy in EN/KR, and the funnel
preview behavior (see §10) need a UX walkthrough before the follow-up
ships branch B and the protected-event marker.

## 10. Funnel preview

**Deferred for the foundation slice.** The issue body specifies that
"slider position changes update the funnel counter ('Triaged /
shown') and the asset list immediately". In this PR, slider movement
updates the **asset list** (and the `events` pivot corpus) but does
NOT update the funnel's `triaged` number: the funnel still renders
`COUNT_TRIAGED_SQL`, the per-window corpus row count, which is
independent of the slider.

The full `shown_top_n` definition the issue calls for requires the
two-branch merge (`composeMenu` + branch B union, deduplicated,
post-cross-tenant cap) and the relabel/rescope of the funnel's
pass-through ratio — both land in the follow-up that ships branch B,
the `eligible_top_n` SQL column, and the per-stop hint preview. The
foundation slice ships the slider's read-path plumbing without
touching the funnel so the funnel work is reviewed alongside branch B
and the protected-event row marker.

## Out of scope

- Corpus B ("With my policies") slider activation — separate follow-up
  per the issue body.
- Per-selector weights (S1–S4 toggles).
- Per-asset Top-N slider.
- Asymmetric thresholds for asset-score vs event-score.
- Phase 2 push payload integration (the slider is read-time UI; the
  push is opportunistic and cursor-based per RFC 0002).
