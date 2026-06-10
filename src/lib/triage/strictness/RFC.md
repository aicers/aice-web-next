# Strictness Slider RFC

- Status: **Draft (Baseline-A scope complete)**
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

This RFC covers the Baseline-A scope end-to-end. The foundation slice
(#595) landed the stop set, the algorithm-level cutoff threading, the
server-action plumbing, and the slider UI with persistence. This
follow-up (#596) adds the Story-protected force-union (branch B), the
multi-tenant dual-cap merge, the protected-event row marker, the
funnel "Shown" segment with `passThroughRate` redefined to
`shown / detected`, the per-stop `eligible_top_n` preview, option (b)
for the slider × quota interaction (`defaultN` multiplier + "All"-stop
quota lift), and the removal of the degenerate
`baseline_triaged_event_event_time_score_idx` (§7a; the index no
longer exists in the v1 schema). Corpus B ("With my policies")
slider activation is split to a separate follow-up.

## 1. Stop count and labels

Five discrete stops, ordered loose → strict in the UI:

| id      | Label    | Cutoff (`baseline_score >=`) | `defaultN` multiplier |
| ------- | -------- | ---------------------------- | --------------------- |
| `all`   | All      | 0                            | quota lifted (`null`) |
| `top80` | Top 80%  | 0.20                         | 2                     |
| `top50` | Top 50%  | 0.50                         | 1                     |
| `top20` | Top 20%  | 0.80                         | 0.5                   |
| `top5`  | Top 5%   | 0.95                         | 0.25                  |

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
per-bucket `composeMenu` quota is **lifted** at "All" under option
(b) (see §6) — the `defaultNMultiplier` is `null` so `composeMenu`
returns every cutoff-surviving row, bounded only by the SQL candidate
cap upstream and the cross-tenant `TRIAGE_HARD_EVENT_CAP` downstream.

The slider's hover tooltip names only the two remaining bounds (the
cadence-threshold floor and the per-bucket SQL candidate cap). The
foundation-slice copy that also mentioned the `composeMenu` quota is
intentionally removed alongside the quota lift. EN/KR copy lives at
`src/i18n/messages/{en,ko}.json::strictnessSlider.allStopHint`.

## 5. Empty-window behavior contract

A zero-row window must render the funnel and the slider with all
counts at `0`, with no error. The bare aggregate without `GROUP BY`
in PostgreSQL always emits one row even on empty input, so the
read-time `cume_dist()` CTE collapses to zero rows and every
downstream count is `0` by construction.

Acceptance fixture: opening the menu on a window with no triaged
events shows the funnel and the slider with zero counts, no error.

## 6. Slider × `composeMenu` quota interaction

**Working choice: option (b) — `defaultN` multiplier + "All"-stop
quota lift.** Each stop carries a multiplier that scales the per-bucket
quota derived from #462's `FINAL_COUNT` curve. The "All" stop's
multiplier is `null` — `composeMenu` skips per-bucket quota allocation
entirely and returns every cutoff-surviving row from the assembled set.

Concrete multiplier table per §1. Rationale:

- Loose stops (`top80`, `top50`) widen `defaultN` so "Top 80%"
  actually expands the rendered set beyond the production default
  (`top50`) and the loose end of the slider feels like a wider net.
  A 2× multiplier on `top80` is the smallest value that visibly
  separates it from the default; larger multipliers would push
  cross-tenant volumes past the `TRIAGE_HARD_EVENT_CAP` cap on
  realistic windows.
- Strict stops (`top20`, `top5`) tighten `defaultN` so the analyst
  who opted into a narrower percentile is not handed a longer list
  than they asked for; the multiplier is the **same direction** as
  the cutoff narrows the cohort.
- `top50` keeps the original `defaultN` (multiplier = 1) so a fresh
  install behaves identically to the production default.

The cutoff is still applied **inside `composeMenu`** (not in the SQL
`ranked` CTE) — applying it at the SQL level would drop buckets whose
rows all sit below the cutoff from the row set `buildCohort` sees,
silently shrinking the aggregate list and redistributing the missing
bucket's quota to surviving buckets. The quota-allocation aggregates
must be computed from the full cohort regardless of the cutoff.

The `MIN_NONZERO_FLOOR` fallback in `composeMenu` respects the cutoff:
when `assembled_count` falls below the floor, the fallback returns the
top-N rows by tie-breaker **from the cutoff-surviving set only**. If
no row survives the cutoff, the fallback returns empty rather than
dipping below the user's stop — a strict stop must not surface a
sub-cutoff row. At the "All" stop the fallback rarely fires (cutoff is
`0` and the quota lift returns every assembled row), but the same
empty-set guard applies when the entire post-`Blocklist*` cohort is
empty.

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

Historical note: an early pre-release schema carried a composite
index `(event_time DESC, baseline_score DESC)` on the assumption the
slider would filter on a stored score column. It did NOT serve the
slider: the baseline score is computed at read time via `cume_dist()`
over `raw_score` (no stored column), so the second column collapsed
and the index degenerated to an `event_time` btree that
`baseline_triaged_event_event_time_idx` already covers.

**Resolution: dropped** — the index no longer exists in any migration
file. The alternative — rebuilding as `(event_time DESC,
raw_score DESC)` — would not serve the production sort either: the
menu cohort SQL partitions `cume_dist()` by `(kind,
baseline_version)`, not by `event_time`, so the planner cannot use
`raw_score` co-locality without a separate
`(kind, baseline_version, raw_score DESC)` index. That index exists
in the tenant schema; the read-time sort is the dominant cost
regardless and is unchanged by this RFC.

## 8. Story-protected hard caps

Branch B (the parallel `EXISTS(event_group_member)` SELECT) is the
"score-OR-Story" carve-out per #471. It bypasses both the per-bucket
SQL candidate cap and `composeMenu`'s per-bucket quota. The merge
layer applies a separate cap so a single tenant cannot blow past the
screen's usable list size.

- **`STORY_PROTECTED_HARD_CAP = 2000`** (merge-layer cap;
  authoritative ceiling). Set smaller than `TRIAGE_HARD_EVENT_CAP`
  because branch B is bounded only by Story membership in the
  window — a few pathologically large Stories should not dominate
  the rendered set.
- **`STORY_PROTECTED_PER_TENANT_LIMIT = 2000`** (per-tenant
  `LIMIT` on branch B SQL). Equal to the merge cap as
  defense-in-depth — a single tenant cannot stream more rows into
  the merge sort than the merge layer would keep.

When branch B saturates the merge cap, the UI surfaces a separate
"N Story members truncated" counter (EN/KR copy at
`src/i18n/messages/{en,ko}.json::triage.storyProtectedTruncatedBannerTemplate`).
The counter is keyed independently of the existing
`TRIAGE_HARD_EVENT_CAP` truncation banner — the two caps fire on
different conditions and the analyst needs to see both.

Acceptance per #471: a Story with two members at `baseline_score
= 0.95` / `0.30`, slider at "Top 5%" — both rows render (the 0.30 row
via branch B), only the 0.30 row shows the marker.

## 9. UX review sign-off

**Pending — staging-refresh blocker.** The walkthrough with UX /
product covering the slider's five-stop layout (RFC §1), EN/KR
labels, the new "Shown" funnel segment (§10), the chain-link
protected marker (§3 of the issue, projected by the asset-detail
SQL via `protected_by_story`), the "N Story members truncated"
banner copy, and the "All" tooltip update (§4 — dropping the
per-bucket quota line now that option (b) lifts the quota) has not
yet taken place. The session needs the same Phase 1.B-seeded
staging tenant called out in §8 (real PNG capture) and §11
(representative measurement) so the reviewers see slider chrome,
the chain-link marker, the per-stop "≈ N" hints, and the
truncation banner against real data in a single session. Sign-off
will be recorded in the follow-up PR that lands the real PNGs and
the measurement numbers; the PR body that ships this RFC also
calls the item out under "Not addressed".

## 10. Funnel `shown` / `passThroughRate` redefinition

The funnel evolves from `{detected, triaged, passThroughRate}` to
`{detected, triaged, shown, passThroughRate}`:

- `triaged` stays as the slider-independent corpus floor (rows that
  survived cadence + exclusions). It does **not** move with the
  slider — analysts use it to answer "how many rows are even in the
  corpus for this window".
- `shown` is the new authoritative displayed-set count — the
  post-quota, post-merge-cap union of branch A and branch B,
  deduplicated. Moves with the slider.
- `passThroughRate` is redefined to `shown / detected`. The
  analyst-visible "pass-through" is the rate of rows that actually
  reach the screen, not the rate that survives cadence.

The redefinition is intentional and is called out in the PR
description so consumers (TypeScript types, JSDoc, EN/KR copy,
tests) are updated in the same change.

### Per-stop hints

The slider chip row surfaces the cheap `eligible_top_n` count per
stop via `COUNT_ELIGIBLE_BY_STOP_SQL` (`COUNT(*) FILTER (WHERE
baseline_score >= :cutoff OR in_story)`). Hints render as "≈ N"
next to each stop label; the SQL is summed across the customer
scope in `loadTriagePeriod`. The funnel "Shown" always shows the
authoritative post-`composeMenu` number, not the cheaper eligible
count — the two diverge whenever the per-bucket quota tightens
branch A.

## 11. Measurement gate

`scripts/measure-baseline-read-path.mjs` is the harness for the
combined `cume_dist() + FILTER`-counts query (`COUNT_ELIGIBLE_BY_STOP_SQL`)
and the branch B SELECT. **Representative p50 / p95 latencies and
`EXPLAIN ANALYZE` output are pending — staging-refresh blocker.**
The harness is wired and accepts the cutoff bind, but the authoring
worktree has no Phase 1.B-seeded customer-tenant DB with ≥30 days
of cadence-filled rows. The numbers required by #471 Performance §5
will be recorded in the follow-up PR that runs the harness against
a refreshed staging tenant (the same window as the UX sign-off in
§9 and the real PNG capture in §8). The structural expectation —
the dominant cost is the `cume_dist()` partition sort node, the
time-window index resolves the prefilter, and the merge layer's
caps bound the SELECT result independent of corpus size — drives
the design but is not a substitute for the measurement.

The drop-or-rebuild decision for
`baseline_triaged_event_event_time_score_idx` (§7a) is a
**structural resolution**, not an outcome of the measurement gate:
the index assumed a stored score column that does not exist in the
v1 schema (the baseline score is read-time `cume_dist()` over
`raw_score`), so its second column could never discriminate and the
index degenerated to an `event_time` btree already covered by
`baseline_triaged_event_event_time_idx` regardless of plan choice.
That conclusion holds without numbers; the measurement gate would
only have been load-bearing on this decision if the rebuild option
were on the table.

## Out of scope

- Corpus B ("With my policies") slider activation — separate follow-up
  per the issue body.
- Per-selector weights (S1–S4 toggles).
- Per-asset Top-N slider.
- Asymmetric thresholds for asset-score vs event-score.
- Phase 2 push payload integration (the slider is read-time UI; the
  push is opportunistic and cursor-based per RFC 0002).
