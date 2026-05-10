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

```
post-exclusion events for the active window
   │
   ├─ (1) hard-exclude BlockList*                      ── never visible to baseline
   │
   ├─ (2) group by kind
   │
   ├─ (3) rank within each kind                         ── selectors S1–S4 fire here only
   │       │
   │       ├─ per-event selectors  → selector_tags at INSERT time
   │       └─ window-level selectors → computed at read time (or persisted; see §10)
   │
   ├─ (4) allocate per-kind slots                       ── adaptive (volume × confidence-distribution + favored-kind bonus)
   │
   └─ (5) merge top-k of each kind into final result    ── final_count bounded by §6
```

The per-event subset of (3) runs inside the cadence pipeline (#481) at INSERT into `baseline_triaged_event` and writes its result into the row's `selector_tags`. The window-level subset of (3), step (4), and step (5) all run at read time when the menu loads a window.

## §1. Hard exclusion: `BlockList*`

`BlockList*` events are themselves a triage output (the user has already chosen to block these by some upstream rule); they are not events worth re-surfacing in the Triage menu. They are dropped at the very front of the pipeline before any scoring.

**Decision: prefix-match rule, not an explicit list.** Any kind whose name starts with `BlockList` is excluded. New `BlockList*` kinds added later are picked up automatically without an RFC update. The exclusion is implemented as a `WHERE kind NOT LIKE 'BlockList%'` clause on the cadence-side INSERT and (defensively) on the menu SELECT.

## §2. Kind-first grouping

After §1 the remaining events are grouped by `kind`. All scoring, selector firing, and ranking happen *within* a single kind's slice. The output of this stage is, conceptually, one ranked list per kind.

This is a deliberate departure from a single global score across all kinds. Because confidence is not cross-kind comparable, a single global ranking would silently bias toward whatever kinds happen to emit higher raw confidence numbers.

## §3. Within-kind ranking — selectors

The four selectors from #462 are reinterpreted as within-kind operators.

### S1. High-confidence (within-kind)

For each event, S1 produces a score equal to its **within-kind percentile rank** of the underlying confidence value over the active statistics window.

- Per-event component (fires at INSERT): cluster_id bonus when `cluster_id` is well-validated for that kind (membership in `WELL_VALIDATED_KINDS`, see §9), and category whitelist hit (`HIGH_PRECISION_CATEGORIES`, see §9).
- Window-level component (fires at read time): the actual percentile rank against the statistics window's distribution.

Threshold for "high-confidence" within a kind: `τ_high` (see §9).

### S2. Severe (within-kind, per-event)

`category ∈ CRITICAL_CATEGORIES` causes S2-severe to fire on the event regardless of confidence. The "rare" branch of the original S2 is dropped: rarity-of-kind is no longer a selector once the algorithm groups by kind. Within-kind rarity (events with unusual feature combinations relative to the kind's history) is captured by S4 instead.

Threshold for "severe": `τ_severe` (see §9).

### S3. Recurring `(asset, kind, dst)` (within-kind, window-level)

For each `(asset, dst)` pair within a kind, S3 fires when the pair appears more than `R` times in the statistics window. Score scales with repetition count, capped to avoid one noisy pair dominating.

Computed at read time via `GROUP BY asset, dst` against `observed_event_meta` filtered to the kind, per §11.

### S4. Correlated (within-kind, window-level)

For each asset within a kind, S4 fires when the asset's events span more than one category in the statistics window. The intuition: an asset emitting one kind under multiple categories is a stronger signal than the same asset emitting the same kind under a single category.

Score scales with category-count, capped.

### `UNLABELED_BONUS`

Per-event, fires when the event is `HttpThreat` and its cluster classifier returned no labeled cluster (detected via the existing `isClusterNone` helper from #451 / #481; sentinels `""`, `"none"`, `"null"` all mean "no cluster"). The signal does NOT require a `review-web` schema change — see [aicers/review-web#857](https://github.com/aicers/review-web/issues/857) for the closed exploration of `clusterId` nullability.

The bonus is kept as a distinct selector with its own weight rather than folded into category scoring (Path 1 of #462's three-path enumeration). This is consistent with the favored-kind list (§5) elevating "unlabeled HttpThreat" — the per-event bonus and the per-kind bonus reinforce each other rather than double-counting, because they enter the formula at different stages (per-event → within-kind ranking; per-kind → slot allocation).

### Selector union semantics

Within-kind score for an event is a **weighted sum** of fired selectors:

```
score(event) = Σ  w_S · indicator(S fires on event)
              S ∈ {S1, S2, S3, S4, UNLABELED_BONUS}
```

Weights `w_S` are tunable (§9). Sum (rather than max) is chosen so that an event firing multiple selectors ranks above one firing only the strongest single selector — this matches the analyst intuition that converging signals are more interesting than any single strong signal.

### Stored score: `baseline_score`

The within-kind score above is then **kind-normalized** before storage in `baseline_triaged_event.baseline_score` so that #471's global percentile slider over `baseline_score` is meaningful:

```
baseline_score(event) = percentile_rank_within_kind(score(event), kind, window)
                       ∈ [0, 1]
```

A 0.95 `baseline_score` therefore means "this event is in the top 5% of its own kind in the window", whatever that kind is. Global percentile thresholds remain comparable across kinds because every kind contributes the same uniform-on-`[0, 1]` distribution by construction.

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
- `normalized_volume(kind, window) ∈ [0, 1]`: that kind's post-exclusion event count over the window, divided by the maximum across all kinds in the window. Bounded so a flood from one kind cannot drive others to zero.
- `normalized_top_confidence(kind, window) ∈ [0, 1]`: a measure of how strong the kind's *top* events are this window relative to that kind's own history. Concretely: the median of the within-kind percentile-rank scores of the kind's top-K events in the window. Always within-kind — no cross-kind comparison.
- `favored_bonus(kind) = β` if `kind ∈ FAVORED_KINDS = {DnsCovertChannel, unlabeled-HttpThreat, LockyRansomware, RepeatedHttpSessions, SuspiciousTlsTraffic}`, else 0. Constant, never decays.

The shares are then normalized to sum to 1 and multiplied by `final_count` (§6) to produce per-kind absolute slot counts. Fractional slots are resolved largest-remainder.

The unlabeled-HttpThreat entry in `FAVORED_KINDS` is a virtual kind: events with `kind = "HttpThreat"` AND `isClusterNone(clusterId)` count toward this slice's share rather than the general-`HttpThreat` slice. Implementation joins on the same `isClusterNone` helper used by `UNLABELED_BONUS`.

### Why this satisfies the adaptiveness requirement

Three forms of adaptiveness are present without any explicit user-feedback signal:

1. **Time-based.** Statistics windows (§7) progressively activate as time passes since deployment (7d window first, 14d at two weeks, 30d at one month). The signal set is strictly monotone-increasing.
2. **Data-accumulation-based.** As `observed_event_meta` grows, percentile-rank estimates become less noisy; the same algorithm produces tighter rankings.
3. **Volume × signal-strength-based.** `slot_share` recomputes per window load, so a kind that suddenly carries strong signals automatically claims more slots; a kind whose events grow weak relative to its own history shrinks. Because `normalized_top_confidence` is within-kind, this re-allocation is not gameable by a kind whose absolute confidences happen to be high.

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

The menu reads `baseline_triaged_event` (corpus A) exclusively (#458). The cadence pipeline (#456 / #481) populates corpus A from `review` on a schedule using a deliberately loose cadence-side threshold; the user-strictness slider (#471) operates only within corpus A and never triggers a `review` re-fetch. Slider movement therefore costs one SELECT against an indexed table, not a re-ingest. The slider's widest position ("All" in #471) is bounded by what the cadence threshold has already brought into corpus A; loosening beyond that is a cadence-threshold tuning concern (#456), not a slider concern.

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

Per-event selectors (S1 cluster_id bonus, S2-severe, `UNLABELED_BONUS`) are unaffected by cold-start; they fire on every event from day one.

## §8. Window-level selector storage

**Decision: read-time computation, no persisted pattern tables.**

Rationale:

- The set of `(asset, kind, dst)` and `(asset, kind, category)` aggregates is bounded by the menu's window size (≤ 30 days) and is recomputed once per menu load, not per event.
- Persisted pattern tables would add a new write path on the cadence schedule, a cleanup/retention concern, and a `baseline_version` migration story — none of which justify themselves at the volumes involved.
- `observed_event_meta` already carries the right indexes for the GROUP BY shape (composite on `(observed_at, kind, asset)` per #456); read-time scans hit them.

If measurement on representative production data shows the per-load aggregation cost is unacceptable, this decision is revisited via a follow-up RFC introducing a daily-rollup pattern table; the algorithm shape above does not change, only where the GROUP BY result lives.

## §9. Tunable parameters

These values fix the algorithm's **shape** but not necessarily their final calibration. All values below are **provisional** and finalized via ops review (with measurement on a representative tenant DB) before #462 merges. Tuning post-merge is via `baseline_version` bump + 30-day natural expiry per #458.

### Selector weights (§3)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `w_S1` | S1 high-confidence weight | 1.0 |
| `w_S2` | S2 severe weight | 1.5 |
| `w_S3` | S3 recurring weight | 0.8 |
| `w_S4` | S4 correlated weight | 0.8 |
| `w_UNLABELED` | UNLABELED_BONUS weight | 0.5 |

### Selector thresholds (§3)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `τ_high` | percentile rank for S1 high-confidence | 0.90 |
| `τ_severe` | (currently unused — S2 is per-event categorical, no threshold) | — |
| `R` | minimum repetitions for S3 | 3 |

`τ_high` is a single global value, not per-kind. Per-kind thresholds add a tuning surface that ops would have to maintain per kind without commensurate accuracy gain at this stage.

### Selector membership lists (§3)

`HIGH_PRECISION_CATEGORIES`, `WELL_VALIDATED_KINDS`, `CRITICAL_CATEGORIES` — initial contents are populated from existing detection metadata at code time and reviewed with ops before merge. Lists are part of source code (e.g., `src/lib/triage/baseline/categories.ts`), not database content; changing them requires a `baseline_version` bump.

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

### Per-event vs window-level selector membership

| Selector | Fires at INSERT | Fires at read time |
|---|---|---|
| S1 cluster_id bonus | ✓ | — |
| S1 percentile rank | — | ✓ |
| S2 severe (category-based) | ✓ | — |
| S3 recurring | — | ✓ |
| S4 correlated | — | ✓ |
| UNLABELED_BONUS | ✓ | — |

`selector_tags` on `baseline_triaged_event` is the per-event subset only. The read path joins window-level selector results onto each row at menu-load time.

## §10. `baseline_version`

A `baseline_version` row is bumped whenever any of:

- a tunable in §9 changes,
- a membership list (§9) changes,
- the algorithm's shape changes,
- a selector is added or removed.

Both corpora pick up the new version on next cadence / next on-demand run. Prior versions converge out of the menu within 30 days via natural expiry. No mass recomputation. Audit retains the per-row `baseline_version` column for reproducibility.

The version is **not** surfaced in the menu UI per #458. Cross-version mixes within a window are resolved by natural expiry, not by user awareness.

## §11. Out of scope (delegated)

- **User strictness slider** — owned by #471 (separate RFC, separate UX review).
- **User-engagement feedback** — owned by #485 (Phase 1 capture, Phase 2 per-kind feedback into `slot_share`, Phase 3 within-kind reranking and selector-weight tuning).
- **Audit/snapshot of baseline parameters at submit time** — owned by #472.
- **`review-web` schema for cluster nullability** — closed, not pursued; sentinel-based detection in §3 is the agreed convention.

## §12. Open questions

1. **Final calibration of §9 values.** The provisional values above are educated starting points. Final values are set after measurement on a representative tenant DB and ops review, before #462 merges.

2. **`LOWER_FLOOR` / `scale` validation.** The provisional `(LOWER_FLOOR=20, scale=30)` log10 curve needs to be sanity-checked against historical incident counts: does it produce a reasonable menu size at both quiet and busy ends of each customer's activity band? If sqrt produces a more useful curve in practice (more responsive to volume changes than log10), the shape choice is revisited before merge — the §6 narrative on "neither linear nor constant" stands either way.

3. **Per-window weighting in §7.** Currently each of the 7d / 14d / 30d signals contributes equally (max across windows). An alternative is to weight shorter windows higher (recent patterns matter more) or longer windows higher (more stable). Preliminary recommendation: equal weighting via max, revisit after Phase 1.B is in production.

4. **`selector_tags` schema.** This RFC assumes `selector_tags` is a `text[]` or JSONB array of fired selector identifiers. The exact column type and indexing strategy is owned by #456 / #481's schema; this RFC requires only that the per-event selectors of §3 can be persisted at INSERT time and read at menu-load time.
