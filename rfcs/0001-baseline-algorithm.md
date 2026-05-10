# RFC 0001: Baseline algorithm

- Status: **Draft**
- Authors: @sehkone
- Tracks: [#462](https://github.com/aicers/aice-web-next/issues/462)
- Related: [#456](https://github.com/aicers/aice-web-next/issues/456), [#458](https://github.com/aicers/aice-web-next/issues/458), [#471](https://github.com/aicers/aice-web-next/issues/471), [#481](https://github.com/aicers/aice-web-next/issues/481), [#485](https://github.com/aicers/aice-web-next/issues/485)

## Summary

Baseline scores every detection event that survives Stage 1 exclusions, so the Triage menu can show only the events most worth a human's attention. This RFC fixes the algorithm's shape: hard-exclude `BlockList*` events, group the remainder by threat kind, rank within each kind, and merge across kinds with adaptive per-kind quotas. Confidence is treated as a within-kind quantity only; cross-kind comparison is never performed. Time, accumulated history, and per-kind volume × signal-strength feedback together produce the adaptiveness #462 promises. User-engagement feedback is delegated to #485.

## Motivation

Detection volume is too high for an analyst to read. Triage's job is to surface the high-priority subset of post-exclusion events. Phase 1.A used a constant placeholder score; this RFC defines the real scoring algorithm that Phase 1.B's menu, asset funnel, and pivots all consume.

Two requirements drive the design:

1. **Adaptiveness.** The algorithm should become more accurate over time without manual intervention.
2. **User-preference (relative).** The user can dial result volume up or down relative to the baseline's recommendation. The dial is owned by #471 (separate RFC).

A third constraint, learned during the design discussion, reshaped the algorithm:

3. **Confidence has no cross-kind meaning.** A 0.8 confidence on `HttpThreat` and a 0.8 confidence on `DnsCovertChannel` are not comparable. Any algorithm step that mixes confidences across kinds is wrong by construction.

## Pipeline

The pipeline splits cleanly across two execution times: per-event scoring runs inside the cadence pipeline at INSERT, while per-window slot allocation and assembly run at menu read.

```
At cadence INSERT (per event, against observed_event_meta history):
   │
   ├─ (1) hard-exclude BlockList*                       ── dropped before any scoring
   │
   ├─ (2) determine kind                                ── implicit; just a column on the event
   │
   └─ (3) compute within-kind score → baseline_score,
          selector_tags                                  ── all selectors S1–S4 + UNLABELED_BONUS,
                                                            persisted on baseline_triaged_event


At menu read (per active window, no per-event recomputation):
   │
   ├─ (4) allocate per-kind slots                       ── per-kind aggregates GROUP BY against
   │                                                       observed_event_meta (volume + P95 confidence)
   │                                                       + favored bonus
   │
   └─ (5) merge top-k of each kind                      ── SELECT FROM baseline_triaged_event,
                                                            ORDER BY baseline_score DESC within kind,
                                                            assemble into final_count rows
```

Step (3) — including window-level selectors S1/S3/S4 — runs inside the cadence pipeline (#481) by `GROUP BY` against `observed_event_meta` at INSERT time; the resulting `baseline_score` and `selector_tags` are persisted on `baseline_triaged_event` and not updated within their `baseline_version`. See §8 for the full timing contract and the trade-off this introduces. Step (5) reads only `baseline_triaged_event` (no joins to derive selector values — they are persisted as columns on each row). Step (4)'s slot-allocation aggregates require a small per-kind GROUP BY against `observed_event_meta` because raw confidence values are needed for `normalized_top_confidence` (§4); `baseline_triaged_event` stores only `baseline_score` (kind-normalized percentile rank) which is uniform within each kind by construction and cannot distinguish kinds. Both reads target tables in the same corpus A schema (`migrations/customer/0003_baseline_corpus_a.sql`) in the active customer-tenant DB, so step (4) is one extra small SELECT, not a cross-DB hop or a re-fetch from `review`.

## §1. Hard exclusion: `BlockList*`

`BlockList*` events are themselves a triage output (the user has already chosen to block these by some upstream rule); they are not events worth re-surfacing in the Triage menu. They are dropped at the very front of the pipeline before any scoring.

**Decision: prefix-match rule, not an explicit list.** Any kind whose name starts with `BlockList` is excluded. New `BlockList*` kinds added later are picked up automatically without an RFC update. The exclusion is implemented as a `WHERE kind NOT LIKE 'BlockList%'` clause on the cadence-side INSERT and (defensively) on the menu SELECT.

## §2. Kind-first grouping

After §1 the remaining events are grouped by `kind`. All scoring, selector firing, and ranking happen *within* a single kind's slice. The output of this stage is, conceptually, one ranked list per kind.

This is a deliberate departure from a single global score across all kinds. Because confidence is not cross-kind comparable, a single global ranking would silently bias toward whatever kinds happen to emit higher raw confidence numbers.

## §3. Within-kind ranking — selectors

The four selectors from #462 are reinterpreted as within-kind operators.

Each selector produces a value in `[0, 1]`. Continuous-valued selectors carry magnitude information (degree of recurrence, percentile of confidence); binary-valued selectors flip on a discrete condition. The score is the weighted sum, kind-normalized before storage.

### S1. High-confidence (within-kind, continuous)

```
s1(event) = within_kind_percentile_rank(confidence(event), kind, window) ∈ [0, 1]
```

The percentile rank is taken against the kind's confidence distribution over the active statistics window from `observed_event_meta` (§7). A 0.92 means "this event's confidence is in the top 8% of same-kind events in the window".

### S2. Severe (within-kind, binary)

```
s2(event) = 1 if category(event) ∈ CRITICAL_CATEGORIES, else 0
```

The "rare" branch of the original S2 is dropped: rarity-of-kind is no longer a selector once the algorithm groups by kind. Within-kind rarity (events with unusual feature combinations relative to the kind's history) is captured by S4 instead.

### S3. Recurring (within-kind, continuous, capped)

```
s3(event) = min(1, max(0, (repeat_count(event, kind, window) - 1) / R))
```

`repeat_count(event, kind, window)` is the number of `observed_event_meta` rows in the active window that share `(orig_addr, resp_addr, kind)` with the event (the schema has no `asset` column; the `(orig_addr, resp_addr)` pair is the asset-pair stand-in). The `-1` excludes the event itself from its own recurrence count, so a singleton scores 0 (never seen before) rather than `1/R`. `R` (§9) is the saturation cap — beyond `R` *additional* occurrences, more do not raise s3 further, preventing a single noisy pair from dominating the score.

### S4. Correlated (within-kind, continuous, capped)

```
s4(event) = min(1, max(0, (distinct_category_count(orig_addr, kind, window) - 1) / C))
```

`distinct_category_count` is the number of distinct `category` values associated with `orig_addr` under this `kind` in the active window from `observed_event_meta`. The `-1` excludes the event's own category, so an asset that has only ever emitted this kind under one category scores 0 — uncorrelated. `C` (§9) is the saturation cap on *additional* categories. The intuition: an asset emitting one kind under multiple categories is a stronger signal than the same asset emitting the same kind under a single category.

### `UNLABELED_BONUS` (per-event, binary)

```
unlabeled(event) = 1 if kind(event) = "HttpThreat" AND isClusterNone(clusterId(event)), else 0
```

The cluster classifier's "no labeled cluster" sentinels (empty string, `"none"`, `"null"`) are detected via the existing `isClusterNone` helper from #451 / #481. The signal does NOT require a `review-web` schema change — see [aicers/review-web#857](https://github.com/aicers/review-web/issues/857) for the closed exploration of `clusterId` nullability.

The bonus is kept as a distinct selector with its own weight rather than folded into category scoring (Path 1 of #462's three-path enumeration). This is consistent with the favored-kind list (§5) elevating "unlabeled HttpThreat" — the per-event bonus and the per-kind bonus reinforce each other rather than double-counting, because they enter the formula at different stages (per-event → within-kind score; per-kind → slot allocation).

### Selector union semantics

Within-kind score is a **weighted sum** of selector values, each in `[0, 1]`:

```
score(event) = w_S1·s1(event) + w_S2·s2(event) + w_S3·s3(event)
             + w_S4·s4(event) + w_UNLABELED·unlabeled(event)
```

Weights `w_S` are tunable (§9). Sum (rather than max) is chosen so that an event with multiple converging signals ranks above one with only the strongest single signal — this matches the analyst intuition that converging signals are more interesting than any single strong signal.

### Stored score: `baseline_score`

The within-kind score is then **kind-normalized** before storage in `baseline_triaged_event.baseline_score` so that a global percentile cutoff (e.g. #471's slider) is meaningful across kinds:

```
baseline_score(event) = within_kind_percentile_rank(score(event), kind, window) ∈ [0, 1]
```

A 0.95 `baseline_score` therefore means "this event is in the top 5% of its own kind in the window", whatever that kind is. Global percentile thresholds remain comparable across kinds because every kind contributes the same uniform-on-`[0, 1]` distribution by construction.

**Tie-breaker.** Continuous selector values yield a high-cardinality `baseline_score`, so ties are uncommon in practice — but when they occur, the secondary order is `(event_time DESC, event_key DESC)` at every read site that orders by `baseline_score`. Both columns are NOT NULL in the schema; the i128 `event_key` is unique, so the order is total.

This tie-breaker is **only** about deterministic row ordering among tied rows. It does **not** change the *set* of rows above any `baseline_score` threshold: `WHERE baseline_score >= cutoff` and `percentile_cont(baseline_score)` operate on `baseline_score` alone, so a block of rows tied at the cutoff is included or excluded atomically. If exact "Top N%" semantics matter — e.g. #471's slider stops promising "exactly the top 5% by row count" rather than "everything above the 95th percentile of the score distribution" — the consumer must rank with `row_number() OVER (ORDER BY baseline_score DESC, event_time DESC, event_key DESC)` and threshold the rank, not the score. Whether to do this is owned by #471's RFC; this RFC's contract is only that the tuple `(baseline_score, event_time, event_key)` is a deterministic total ordering.

**INSERT-time evaluation.** All selectors above (S1, S2, S3, S4, `UNLABELED_BONUS`) are evaluated by the cadence pipeline (§481) at INSERT time using `observed_event_meta`'s state at that moment. The resulting `score(event)` and `baseline_score(event)` are persisted on `baseline_triaged_event`. `baseline_score` is therefore a snapshot — it does not retroactively update when later peer events would change S3 or S4. The drift exposure is bounded by retention rather than by re-scoring: see §8 for the full discussion of the 30-day typical menu window vs the 180-day corpus retention.

## §4. Per-kind slot allocation (adaptive)

Each kind's share of the final menu is:

```
slot_share(kind) = base_share
                 + α · normalized_volume(kind, window)
                       · normalized_top_confidence(kind, window)
                 + favored_bonus(kind)
```

where:

- `base_share` is a small constant given to every kind (newly-observed kinds included). Acts as a discoverability floor: a kind that has never been seen still gets a non-zero share when it first appears.
- `normalized_volume(kind, window) ∈ [0, 1]`: that kind's event count over the window, divided by the maximum across all kinds in the window. Computed via `GROUP BY kind` against `observed_event_meta` filtered to the active window. Bounded so a flood from one kind cannot drive others to zero.
- `normalized_top_confidence(kind, window) ∈ [0, 1]`: a measure of how strong the kind's *top* events are this window. Concretely: `percentile_cont(0.95) WITHIN GROUP (ORDER BY confidence)` over `observed_event_meta` rows for this `kind` in the active window — the 95th-percentile raw confidence value for the kind/window. Already in `[0, 1]` because the underlying `confidence` is. This term **does compare absolute confidence values across kinds**, in deliberate tension with the within-kind-only principle that governs event ranking — see open question 6 in §12.
- `favored_bonus(kind) = β` if `kind ∈ FAVORED_KINDS = {DnsCovertChannel, unlabeled-HttpThreat, LockyRansomware, RepeatedHttpSessions, SuspiciousTlsTraffic}`, else 0. Constant, never decays.

The shares are then normalized to sum to 1 and multiplied by `final_count` (§6) to produce per-kind absolute slot counts. Fractional slots are resolved largest-remainder.

The unlabeled-HttpThreat entry in `FAVORED_KINDS` is a virtual kind: events with `kind = "HttpThreat"` AND `isClusterNone(clusterId)` count toward this slice's share rather than the general-`HttpThreat` slice. Implementation joins on the same `isClusterNone` helper used by `UNLABELED_BONUS`.

### Why this satisfies the adaptiveness requirement

Three forms of adaptiveness are present without any explicit user-feedback signal:

1. **Time-based.** Statistics windows (§7) progressively activate as time passes since deployment (7d window first, 14d at two weeks, 30d at one month). The signal set is strictly monotone-increasing.
2. **Data-accumulation-based.** As `observed_event_meta` grows, percentile-rank estimates become less noisy; the same algorithm produces tighter rankings.
3. **Volume × signal-strength-based.** `slot_share` recomputes per window load, so a kind suddenly carrying strong signals (high volume, high P95 confidence) automatically claims more slots, and a kind whose activity ebbs in either dimension shrinks. With the simple `percentile_cont(0.95)` definition above, a kind that consistently produces high-confidence events in absolute terms will tend to claim more share than one whose strong signals sit at lower absolute confidence; this is mitigated by `base_share` (which guarantees newly-observed and quiet kinds a discoverability floor) and by `favored_bonus` (which keeps the empirically-useful kinds visible regardless of confidence-distribution drift). Open question 6 in §12 discusses the option of normalizing against a kind's own historical confidence distribution if this trade-off proves too coarse in practice.

User-engagement-driven adaptiveness (clicks, action-based feedback) is **out of scope of this RFC**; it is delegated to #485, which will land in subsequent `baseline_version` bumps once signal distribution is observable.

## §5. Favored kinds

Empirical experience identifies five kinds as consistently producing useful results:

```
FAVORED_KINDS = {
    DnsCovertChannel,
    unlabeled-HttpThreat,        // virtual kind: HttpThreat + isClusterNone
    LockyRansomware,
    RepeatedHttpSessions,
    SuspiciousTlsTraffic,
}
```

Role: **prior weighting**, not a whitelist. Non-favored kinds still receive `base_share` and can earn additional share through volume × signal-strength. The favored bonus is an additive constant (`β`) and does not decay over time.

## §6. Final count and user-preference dial

`default_N` grows **sublinearly** with post-exclusion volume — neither linearly proportional (which would let a noisy day flood the menu) nor a fixed constant (which would ignore the customer's actual activity level):

```
default_N = round(LOWER_FLOOR + scale · log10(1 + post_exclusion_event_count))
```

The log10 shape buys two properties at once:

- `LOWER_FLOOR` ensures even very quiet days surface something to look at.
- The slow growth of log10 naturally bounds the menu near an analyst-readable size without a hard cap constant; the customer's activity level is reflected, not equated to raw volume.

Final count then applies the user-preference dial and guarantees non-emptiness when any events exist:

```
final_count = max(MIN_NONZERO_FLOOR,
                  min(default_N · user_dial, post_exclusion_event_count))
              if post_exclusion_event_count > 0

final_count = 0
              if post_exclusion_event_count = 0
```

- `final_count` is bounded above by the actual number of post-exclusion events; the menu is never padded with low-score events to hit a fixed number.
- `MIN_NONZERO_FLOOR` guarantees a non-empty menu whenever any event survives Stage 1 exclusion. If `default_N · user_dial` rounds to 0 (very small dial position, very small post-exclusion count), top-`MIN_NONZERO_FLOOR` events by `baseline_score` are surfaced.
- `user_dial` is the user-preference multiplier delivered by #471. The dial is **relative**, not absolute: the user expresses "more" or "less" relative to `default_N`, never a target row count.

The dial mechanism (continuous vs discrete, percentile cutoff vs volume multiplier, UI shape) is owned by #471 and not respecified here. This RFC requires only that the dial output is interpretable as a multiplier on `default_N` or — equivalently — a percentile cutoff on `baseline_score`. The kind-normalized `baseline_score` defined in §3 makes both interpretations mutually consistent.

### Read scope: corpus A only

The menu reads from corpus A only — both tables in `migrations/customer/0003_baseline_corpus_a.sql`, in the active customer-tenant DB. `baseline_triaged_event` carries the events themselves and the persisted per-event scoring (`baseline_score`, `selector_tags`); `observed_event_meta` is consulted once per menu load for the per-kind slot-allocation aggregates of §4 (volume + P95 confidence by kind). Neither read calls `review`. The cadence pipeline (#456 / #481) populates both tables from `review` on a schedule using a deliberately loose cadence-side threshold.

The user-strictness slider (#471) is narrower in scope than menu load: slider movement does not change slot allocation, only the score cutoff over the already-allocated rows, so a slider step is one SELECT against `baseline_triaged_event` — not a re-ingest, not a slot-allocation recompute, not an `observed_event_meta` round-trip. The slider's widest position ("All" in #471) is bounded by what the cadence threshold has already brought into corpus A; loosening beyond that is a cadence-threshold tuning concern (#456), not a slider concern.

## §7. Statistics window

All window-level computations (S1 percentile rank, S3 recurring, S4 correlated, `normalized_volume`, `normalized_top_confidence`) run against three concurrent window lengths:

- 7-day window
- 14-day window
- 30-day window

Per-window selector outputs are combined via **max** within a single selector (the strongest signal across the three windows wins for that selector); selector union across selectors remains the weighted sum of §3.

### Statistics source

PostgreSQL `GROUP BY` against `observed_event_meta` (#456) on the customer's tenant DB. NOT against `baseline_triaged_event` — that would create a circular selection bias. `review` is never asked to compute aggregates; its RocksDB key layout is not optimized for arbitrary-dimension grouping.

### Cold-start

A window activates only once that much wall-clock time has elapsed since deployment. The 7d window is available 7 days after first ingest; 14d at 14 days; 30d at 30 days. Before activation, the corresponding window's signals contribute 0.

This makes cold-start a pure function of elapsed time. No row-count threshold is needed — a 7d window with 7 days of low-volume data is still meaningful (it correctly reflects the customer's actual activity), whereas a 30d window with only 2 days of data is meaningless regardless of row count. Time is the right proxy.

Per-event selectors (S2 severe, `UNLABELED_BONUS`) are unaffected by cold-start; they fire on every event from day one.

## §8. Score computation timing

**Decision: all selectors evaluated at cadence INSERT time, persisted in `baseline_triaged_event.baseline_score`. No persisted pattern tables. No re-scoring at read time.**

Concretely, when the cadence pipeline (§481) processes a new event:

1. The event is appended to `observed_event_meta` (the unbiased denominator) along with its peers in the same cadence batch.
2. For each event in the batch, the pipeline computes s1 / s3 / s4 by `GROUP BY` against `observed_event_meta` filtered to the active statistics window (§7) and the relevant grouping keys. s2 and `UNLABELED_BONUS` need no aggregation.
3. The weighted sum `score(event)` and the kind-normalized `baseline_score(event)` are written to `baseline_triaged_event` along with `selector_tags`. Once written, they are not updated within their `baseline_version`.

Rationale:

- The schema already commits to a persisted score column: `baseline_triaged_event.baseline_score DOUBLE PRECISION`, with composite index `(event_time DESC, baseline_score DESC)` (`migrations/customer/0003_baseline_corpus_a.sql`). This index is precisely what #471's slider needs, and only works against a stored value.
- The relevant `observed_event_meta` indexes for the cadence-time GROUP BY are `event_time DESC` (the time-window slice) and `(kind, event_time DESC)` (kind-filtered window). The schema has no `asset` column; the asset-pair stand-in is `(orig_addr, resp_addr)` (and `orig_addr` for S4's per-asset grouping). The hash aggregate on `(orig_addr, resp_addr)` or `(orig_addr, kind)` runs over the kind/time-filtered slice; planner choice is verified during measurement (§12).
- Persisted pattern tables would add a separate write path, a retention concern, and a `baseline_version` migration story for what is already a bounded, schedulable computation inside the cadence runner.
- Score drift from later peer events: snapshot scores on `baseline_triaged_event` are not retroactively updated when new peer events arrive in `observed_event_meta` and would change S3 / S4 / S1 percentile rank. The exposure bound depends on the user's active menu window, not on a single uniform "expiry":

  | Active menu window | Drift exposure for visible rows |
  |---|---|
  | Last 7d / 14d / 30d (typical menu use, per #458) | bounded to that window's age |
  | Up to 180d (corpus A retention is 180d per `migrations/customer/0003_baseline_corpus_a.sql`; `observed_event_meta` is only 30d) | up to 180d in the worst case — and beyond 30d the `observed_event_meta` history that produced the score has itself rolled over, so re-scoring is not even possible from current state |

  In other words, snapshot scores remain stable **within** their `baseline_version`, but the older a row gets the more its score reflects state-of-the-world at its INSERT time rather than now. Mass re-scoring is explicitly not part of the design. If a future requirement makes long-window drift unacceptable, the mitigation is either tighter retention on `baseline_triaged_event` or a `baseline_version` bump that triggers natural turnover — the algorithm shape above does not change.

If measurement on representative production data shows the cadence-time aggregation cost is unacceptable, the fallback is a follow-up RFC introducing per-cadence-run pattern caches; the algorithm shape above (continuous selectors, weighted sum, kind-normalized stored score) does not change, only where the GROUP BY result lives.

## §9. Tunable parameters

These values fix the algorithm's **shape** but not necessarily their final calibration. All values below are **provisional** and finalized via ops review (with measurement on a representative tenant DB) before #462 merges. Tuning post-merge is via `baseline_version` bump; rows of the older version turn over within the typical menu window (~30 days per #458) and within corpus A's 180-day retention overall (§10).

### Selector weights (§3)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `w_S1` | S1 high-confidence weight | 1.0 |
| `w_S2` | S2 severe weight | 1.5 |
| `w_S3` | S3 recurring weight | 0.8 |
| `w_S4` | S4 correlated weight | 0.8 |
| `w_UNLABELED` | UNLABELED_BONUS weight | 0.5 |

### Selector saturation caps (§3)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `R` | S3 saturation cap (repeat count past which s3 stays at 1.0) | 10 |
| `C` | S4 saturation cap (distinct categories past which s4 stays at 1.0) | 4 |

S1 needs no saturation cap — its output is already a percentile rank in `[0, 1]`. S2 and `UNLABELED_BONUS` are binary and saturated by definition.

`selector_tags` content (the analyst-visible label set) parallels but is not identical to selector contributions: a tag is emitted when a selector's value exceeds an implementation-level "this fired meaningfully" threshold (e.g. `s1 > 0.85` → `"S1-high"`, `s3 > 0.5` → `"S3-recurring"`). Exact tag thresholds are implementation details and do not affect `baseline_score`; they exist purely for analyst readability of why an event was elevated.

### Selector membership lists (§3)

`CRITICAL_CATEGORIES` — the only membership list referenced by the revised selectors (S2 fires when `category(event) ∈ CRITICAL_CATEGORIES`). Initial contents are populated from existing detection metadata at code time and reviewed with ops before merge. Stored in source code (e.g., `src/lib/triage/baseline/categories.ts`), not in the database; changing the list requires a `baseline_version` bump.

`FAVORED_KINDS` (§5) is a related membership list affecting per-kind slot allocation, not within-kind selector firing; it lives next to `CRITICAL_CATEGORIES` and follows the same source-code + version-bump rules.

### Slot allocation (§4)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `base_share` | floor share per kind | 0.02 |
| `α` | volume × confidence coefficient | 1.0 |
| `β` | favored-kind constant bonus | 0.10 |

### Final count (§6)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `LOWER_FLOOR` | minimum `default_N` (any non-empty corpus, dial neutral) | 20 |
| `scale` | log10 coefficient on post-exclusion volume | 30 |
| `MIN_NONZERO_FLOOR` | minimum `final_count` when post-exclusion > 0 | 1 |

Reference values from this curve (`LOWER_FLOOR = 20`, `scale = 30`, dial neutral):

| post-exclusion events | `default_N` |
|---|---|
| 100 | 80 |
| 1,000 | 110 |
| 10,000 | 140 |
| 100,000 | 170 |

`scale` and `LOWER_FLOOR` are calibrated on representative tenant data before merge so neutral-dial menu size sits in the analyst-readable range across the customer fleet's activity bands.

### Selector evaluation timing

All selectors are evaluated at cadence INSERT time (§8) using `observed_event_meta` history at that moment. `score(event)`, `baseline_score(event)`, and `selector_tags(event)` are persisted on `baseline_triaged_event` and not updated within their `baseline_version`. The read path needs no joins to derive selector values — they are read directly off `baseline_triaged_event` columns. Per-kind slot allocation (§4) issues a small auxiliary aggregation against `observed_event_meta` once per menu load to read raw confidence; this is unrelated to per-event selector values.

| Selector | Source data |
|---|---|
| S1 within-kind percentile rank | event's `confidence` + `observed_event_meta.confidence` history for same `kind` in the window |
| S2 severe | event's `category` only (no aggregation) |
| S3 recurring | `observed_event_meta` GROUP BY `(orig_addr, resp_addr, kind)` in the window |
| S4 correlated | `observed_event_meta` GROUP BY `(orig_addr, kind)` with `COUNT(DISTINCT category)` in the window |
| UNLABELED_BONUS | event's `clusterId` only (no aggregation) |

## §10. `baseline_version`

A `baseline_version` row is bumped whenever any of:

- a tunable in §9 changes,
- a membership list (§9) changes,
- the algorithm's shape changes,
- a selector is added or removed.

Both corpora pick up the new version on next cadence / next on-demand run. Prior-version rows converge out of the **typical menu window** (last 30 days, per #458's documented analyst use) via natural turnover; rows in periods past that horizon may still carry an older `baseline_version` for the rest of the **180-day corpus A retention**. The menu therefore presents a single-version view for typical use but can present a version-mix when the user expands the period beyond ~30 days. No mass recomputation. Audit retains the per-row `baseline_version` column for reproducibility.

The version is **not** surfaced in the menu UI per #458. The cross-version-mix possibility on long windows is resolved by natural turnover and audit-side `baseline_version` access, not by user awareness.

## §11. Out of scope (delegated)

- **User strictness slider** — owned by #471 (separate RFC, separate UX review).
- **User-engagement feedback** — owned by #485 (Phase 1 capture, Phase 2 per-kind feedback into `slot_share`, Phase 3 within-kind reranking and selector-weight tuning).
- **Audit/snapshot of baseline parameters at submit time** — owned by #472.
- **`review-web` schema for cluster nullability** — closed, not pursued; sentinel-based detection in §3 is the agreed convention.

## §12. Open questions

1. **Final calibration of §9 values.** The provisional values above are educated starting points. Final values are set after measurement on a representative tenant DB and ops review, before #462 merges.

2. **`LOWER_FLOOR` / `scale` validation.** The provisional `(LOWER_FLOOR=20, scale=30)` log10 curve needs to be sanity-checked against historical incident counts: does it produce a reasonable menu size at both quiet and busy ends of each customer's activity band? If sqrt produces a more useful curve in practice (more responsive to volume changes than log10), the shape choice is revisited before merge — the §6 narrative on "neither linear nor constant" stands either way.

3. **Per-window weighting in §7.** Currently each of the 7d / 14d / 30d signals contributes equally (max across windows). An alternative is to weight shorter windows higher (recent patterns matter more) or longer windows higher (more stable). Preliminary recommendation: equal weighting via max, revisit after Phase 1.B is in production.

4. **Cadence-time aggregation cost.** `migrations/customer/0003_baseline_corpus_a.sql` provides `(event_time DESC)` and `(kind, event_time DESC)` indexes on `observed_event_meta`. The cadence-time GROUP BY for s3 and s4 runs over the kind-and-time-filtered slice with a hash aggregate on `(orig_addr, resp_addr)` or `(orig_addr, kind)`. This needs `EXPLAIN ANALYZE` on a representative tenant DB before merge to confirm the planner picks the composite index and that the per-batch aggregation completes within the cadence runner's time budget. If it does not, §8's fallback (per-cadence-run pattern cache) is taken; the algorithm shape does not change.

5. **`selector_tags` content.** The schema gives `selector_tags TEXT[]`; tag membership is decided by per-selector "fired meaningfully" thresholds set in code, not in this RFC. Whether tag thresholds should ever leak into `baseline_version` (so changing them requires a version bump) is left for ops review — the conservative answer is yes (any change to what tags appear should be auditable through `baseline_version`), but tags are not load-bearing for `baseline_score` so the impact of skipping a bump is purely cosmetic.

6. **Cross-kind absolute confidence in `normalized_top_confidence` (§4).** The slot-allocation formula compares raw confidence values across kinds via `percentile_cont(0.95)` on `observed_event_meta.confidence`, in tension with the RFC's broader within-kind-only principle for event ranking. The trade-off is intentional: slot allocation is a system-wide attention decision (how much menu bandwidth each kind deserves), not within-event ranking. If ops review or measurement shows this is too coarse — e.g., a kind whose confidences are absolutely high but stable consistently dominates slots over a kind whose confidences are absolutely low but spiking — the alternative is to normalize against each kind's own historical confidence distribution (a ratio of `percentile_cont(0.95)` over the active window vs. over a longer reference period). That requires a second per-kind aggregation and a longer-than-30d reference, which `observed_event_meta`'s 30-day retention does not currently provide; revisiting this would be a follow-up RFC.
