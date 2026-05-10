# RFC 0001: Baseline algorithm

- Status: **Draft**
- Authors: @sehkone
- Tracks: [#462](https://github.com/aicers/aice-web-next/issues/462)
- Related: [#456](https://github.com/aicers/aice-web-next/issues/456), [#458](https://github.com/aicers/aice-web-next/issues/458), [#471](https://github.com/aicers/aice-web-next/issues/471), [#481](https://github.com/aicers/aice-web-next/issues/481), [#485](https://github.com/aicers/aice-web-next/issues/485)

## Summary

Baseline scores every detection event that survives Stage 1 exclusions, so the Triage menu can show only the events most worth a human's attention. This RFC fixes the algorithm's shape: hard-exclude `BlockList*` events, group the remainder by threat kind, rank within each kind, and merge across kinds with adaptive per-kind quotas. Confidence is treated as a within-kind quantity only; cross-kind comparison is never performed. Time, accumulated history, and per-kind volume × signal-richness feedback together produce the adaptiveness #462 promises. User-engagement feedback is delegated to #485.

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
   └─ (3) compute within-kind weighted sum →            ── all selectors S1–S4 + UNLABELED_BONUS;
          raw_score, selector_tags                          raw_score and selector_tags persisted
                                                            on baseline_triaged_event.
                                                            baseline_score is NOT persisted at INSERT.


At menu read (per active window, no per-event recomputation):
   │
   ├─ (4) compute baseline_score on the fly             ── CUME_DIST() OVER (PARTITION BY kind,
   │                                                       baseline_version ORDER BY raw_score)
   │                                                       over rows in the active window; see §3.
   │
   ├─ (5) allocate per-kind slots                       ── per-kind aggregates GROUP BY against
   │                                                       baseline_triaged_event (volume + average
   │                                                       selector_tags length) + favored bonus
   │
   └─ (6) merge top-k of each kind                      ── SELECT FROM baseline_triaged_event,
                                                            ORDER BY baseline_score DESC within kind,
                                                            assemble into final_count rows
```

Step (3) — including window-level selectors S1/S3/S4 — runs inside the cadence pipeline (#481) by `GROUP BY` against `observed_event_meta` at INSERT time; the resulting `raw_score` (the weighted sum) and `selector_tags` are persisted on `baseline_triaged_event` and not updated within their `baseline_version`. `baseline_score` is **not** persisted at INSERT — it is the read-time `CUME_DIST()` window function defined in §3. See §8 for the full timing contract and §11 for the read-path performance contract. Steps (4)–(6) read only `baseline_triaged_event` — `baseline_score` is derived from `raw_score` in a CTE/window pass, slot-allocation aggregates use `selector_tags` array length as the signal-richness proxy (§4), so no raw confidence column is needed at read time and no second-table join. `observed_event_meta` is consulted only at cadence INSERT (step 3), never at menu read.

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
s3(event) = 0
            if orig_addr(event) IS NULL OR resp_addr(event) IS NULL
          = min(1, max(0, (repeat_count(event, kind, window) - 1) / R))
            otherwise
```

`repeat_count(event, kind, window)` is the number of `observed_event_meta` rows in the active window that share `(orig_addr, resp_addr, kind)` with the event (the schema has no `asset` column; the `(orig_addr, resp_addr)` pair is the asset-pair stand-in). Both address columns are nullable in the schema; an event missing either address has no asset-pair identity, so it cannot meaningfully participate in recurrence — s3 is 0 in that case rather than letting all NULL-address events collide into one synthetic group. The `-1` excludes the event itself from its own recurrence count, so a singleton scores 0 (never seen before) rather than `1/R`. `R` (§9) is the saturation cap — beyond `R` *additional* occurrences, more do not raise s3 further, preventing a single noisy pair from dominating the score.

### S4. Correlated (within-kind, continuous, capped)

```
s4(event) = 0
            if orig_addr(event) IS NULL
          = min(1, max(0, (distinct_category_count(orig_addr, kind, window) - 1) / C))
            otherwise
```

`distinct_category_count` is the number of distinct `category` values associated with `orig_addr` under this `kind` in the active window from `observed_event_meta`. `orig_addr` is nullable; an event with no source address has no asset identity for the per-asset GROUP BY, so s4 is 0 for it. The `-1` excludes the event's own category, so an asset that has only ever emitted this kind under one category scores 0 — uncorrelated. `C` (§9) is the saturation cap on *additional* categories. The intuition: an asset emitting one kind under multiple categories is a stronger signal than the same asset emitting the same kind under a single category.

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

### Stored score: `raw_score`, computed view: `baseline_score`

The cadence pipeline persists the raw weighted sum at INSERT:

```
raw_score(event) = score(event) = w_S1·s1 + w_S2·s2 + w_S3·s3 + w_S4·s4 + w_UNLABELED·unlabeled
```

`raw_score` is immutable — once written for a `(event_key, baseline_version)` it is not updated. It carries no order-of-insertion dependency.

`baseline_score` is the kind-normalized cumulative distribution, **computed at read time** as a window function over `raw_score`:

```sql
CUME_DIST() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score)
    AS baseline_score
```

The partition is `(kind, baseline_version)`, not `kind` alone. `raw_score` values are not comparable across baseline versions (the underlying selector formulas differ between versions), so each `(kind, baseline_version)` cohort is ranked independently. This is what makes §10's long-window version-mix legal: rows from an older `baseline_version` keep their own per-cohort rank instead of being silently dropped from the menu or compared on the new version's scale.

`CUME_DIST` returns the cumulative fraction `(rows_with_value_<=_current) / partition_size`. For a single-row partition it returns `1.0`, so cold-start needs no special handling. Tied `raw_score` peers all receive the same `baseline_score` value (PostgreSQL ties-as-peers semantics).

**`baseline_score >= X` is *not* exactly the top `(1-X)` fraction by row count.** Because `CUME_DIST` takes discrete steps `1/N, 2/N, ..., 1`, a threshold of 0.95 against a 100-row partition admits ranks 95..100 — six rows, not five — and ties at the boundary admit the entire tied block atomically. The slider stops in #471 are score-thresholds against this cumulative distribution; if exact "Top N% by row count" semantics matter for a particular consumer, that consumer ranks with `row_number() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score DESC, event_time DESC, event_key DESC)` and thresholds the rank, not `baseline_score`. This RFC's contract is only that `baseline_score = CUME_DIST(...)` per the formula above and that the resulting cutoffs are stable and deterministic; how each consumer interprets "top X%" is the consumer's choice.

Computed against the read-time cohort: the rows in the active menu window in `baseline_triaged_event`, with no version filter — `PARTITION BY (kind, baseline_version)` does the version separation in-query. Read-time computation is what makes the uniform-on-`[0, 1]` property hold within each `(kind, baseline_version)` partition by construction — every row in a partition contributes one rank-position, so no insertion order, no batch boundary, and no rising raw-score trend distorts the distribution.

INSERT-time computation was rejected because it would have ranked each new event against only the peers already in the table at that moment. With raw scores trending upward (model improvements, increasing sensitivity over time), every new event would land near 1.0; the first row of every cadence batch would always be a cold-start at 1.0; and the global percentile slider in #471 would no longer cut at the actual top-5% across kinds.

Read-time computation also means `baseline_score` is **not** a persisted column in this RFC's design. The `baseline_score DOUBLE PRECISION` column already in `migrations/customer/0003_baseline_corpus_a.sql` may be retained as a denormalized cache (refreshed periodically by the cadence runner if measurement shows the read-time `CUME_DIST` is too slow at production scale), or repurposed; the RFC's contract is only that the value `CUME_DIST() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score)` is what `baseline_score` *means*. #471's slider is the single most performance-sensitive consumer; its measurement gate (already documented in #471's RFC) is the place where any caching decision is made empirically — see §11 for the contract this RFC actually commits to.

A 0.95 `baseline_score` means "this event is in the top 5% of its own kind in the active window", whatever that kind is. Global percentile thresholds remain comparable across kinds because every kind contributes the same uniform-on-`[0, 1]` distribution by construction.

**Tie-breaker.** Continuous selector values yield a high-cardinality `baseline_score`, so ties are uncommon in practice — but when they occur, the secondary order is `(event_time DESC, event_key DESC)` at every read site that orders by `baseline_score`. Both columns are NOT NULL in the schema; the i128 `event_key` is unique, so the order is total.

This tie-breaker is **only** about deterministic row ordering among tied rows. It does **not** change the *set* of rows above any `baseline_score` threshold: `WHERE baseline_score >= cutoff` and `percentile_cont(baseline_score)` operate on `baseline_score` alone, so a block of rows tied at the cutoff is included or excluded atomically. If exact "Top N%" semantics matter — e.g. #471's slider stops promising "exactly the top 5% by row count" rather than "everything above the 95th percentile of the score distribution" — the consumer must rank with `row_number() OVER (ORDER BY baseline_score DESC, event_time DESC, event_key DESC)` and threshold the rank, not the score. Whether to do this is owned by #471's RFC; this RFC's contract is only that the tuple `(baseline_score, event_time, event_key)` is a deterministic total ordering.

**INSERT-time evaluation.** All selectors above (S1, S2, S3, S4, `UNLABELED_BONUS`) are evaluated by the cadence pipeline (§481) at INSERT time using `observed_event_meta`'s state at that moment. The resulting `raw_score(event)` is persisted on `baseline_triaged_event` along with `selector_tags`. `raw_score` is therefore a snapshot — it does not retroactively update when later peer events would change S3 or S4. The drift exposure is bounded by retention rather than by re-scoring: see §8 for the full discussion of the 30-day typical menu window vs the 180-day corpus retention. `baseline_score` is computed at read time from `raw_score` (§3 stored score), so it always reflects the actual cohort at read; it has no INSERT-time snapshot semantics.

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
- `normalized_volume(kind, window) ∈ [0, 1]`: that kind's event count over the active window in `baseline_triaged_event`, divided by the maximum across all kinds in the same window. Bounded so a flood from one kind cannot drive others to zero. Source is `baseline_triaged_event` (not `observed_event_meta`) so the count is over the post-`BlockList*` set — the same denominator that slot allocation distributes among.
- `normalized_top_confidence(kind, window) ∈ [0, 1]`: a measure of how *signal-rich* the kind's events are this window. Concretely, `avg(coalesce(cardinality(selector_tags), 0)) / MAX_TAGS` over `baseline_triaged_event` rows for this `kind` in the active window, where `MAX_TAGS` is the total number of distinct selector tags the cadence pipeline can emit (§9). The `coalesce` guards both NULL `selector_tags` columns and PostgreSQL's quirk that `array_length('{}', 1)` returns `NULL` rather than `0`; without it, zero-tag rows would silently drop from `avg` and groups whose rows are all empty/NULL would produce a NULL slot share. A kind whose events frequently fire multiple selectors (S1-high + S3-recurring + S4-correlated, etc.) scores higher than one whose events typically fire only a single selector. Computed entirely from `selector_tags` — no raw confidence column is read, so the within-kind-only rule for confidence (§ "Pipeline" intro) is respected: signal-richness is measured from the algorithm's own selector firings, not from upstream confidence values.
- `favored_bonus(kind) = β` if `kind ∈ FAVORED_KINDS = {DnsCovertChannel, unlabeled-HttpThreat, LockyRansomware, RepeatedHttpSessions, SuspiciousTlsTraffic}`, else 0. Constant, never decays.

The shares are then normalized to sum to 1 and multiplied by `final_count` (§6) to produce per-kind absolute slot counts. Fractional slots are resolved by the largest-remainder method. **Tie-breaker** when two kinds have exactly equal remainders: the extra slot goes to the kind whose name sorts first lexicographically. The tie-breaker is included so the algorithm is fully deterministic — `FAVORED_KINDS` membership and `β` already differentiate priority where it matters; lexicographic ordering only resolves the rare floating-point coincidence.

The `unlabeled-HttpThreat` entry in `FAVORED_KINDS` is a virtual kind, and slot-allocation aggregates GROUP BY `(kind, is_unlabeled)` where `is_unlabeled = (kind = 'HttpThreat' AND 'unlabeled-cluster' = ANY(selector_tags))`. The pair `('HttpThreat', true)` is treated as the virtual kind for `FAVORED_KINDS` membership and slot share. Because the unlabeled flag is detected via `selector_tags` — written at cadence INSERT by §3's `UNLABELED_BONUS` — slot allocation does not need a separate `clusterId` column on any read-time table.

### Why this satisfies the adaptiveness requirement

Three forms of adaptiveness are present without any explicit user-feedback signal:

1. **Time-based.** Statistics windows (§7) progressively activate as time passes since deployment (7d window first, 14d at two weeks, 30d at one month). The signal set is strictly monotone-increasing.
2. **Data-accumulation-based.** As `observed_event_meta` grows, percentile-rank estimates become less noisy; the same algorithm produces tighter rankings.
3. **Volume × signal-richness-based.** `slot_share` recomputes per window load, so a kind suddenly carrying many events with multiple selectors firing (high volume, high average tag count) automatically claims more slots, and a kind whose activity ebbs in either dimension shrinks. Because signal-richness is measured from `selector_tags` — i.e., from the algorithm's own selectors against globally-uniform thresholds — there is no cross-kind confidence comparison and no violation of the within-kind-only rule for raw confidence. The `base_share` floor and `favored_bonus` constant keep newly-observed kinds discoverable and the empirically-useful kinds visible regardless of how the volume × signal-richness term moves.

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

Role: **prior weighting**, not a whitelist. Non-favored kinds still receive `base_share` and can earn additional share through volume × signal-richness (§4). The favored bonus is an additive constant (`β`) and does not decay over time.

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

The menu reads from corpus A — `baseline_triaged_event` exclusively at menu read time (#458). `observed_event_meta` is the cadence pipeline's INSERT-time aggregation source (§8) and is not touched at read time. Both tables live in the active customer-tenant DB per `migrations/customer/0003_baseline_corpus_a.sql`. Neither read path calls `review`. The cadence pipeline (#456 / #481) populates both tables from `review` on a schedule using a deliberately loose cadence-side threshold.

Slot allocation (§4) is a small per-kind GROUP BY over `baseline_triaged_event`, computed once per menu load. It uses `selector_tags` array length as the signal-richness signal so no raw confidence column is needed and no second-table join is introduced.

### Read-path performance contract

Because `baseline_score` is read-time-computed (§3, §8), the existing `(event_time DESC, baseline_score DESC)` index does **not** apply to the slider's score cutoff. The performance contract this RFC actually commits to:

- **Menu load** runs the `CUME_DIST() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score)` pass once over the active window. The window-function cost scales with the number of rows in the active window per `(kind, baseline_version)` partition. The `(event_time DESC)` index on `baseline_triaged_event` resolves the time slice; the per-partition sort is over each partition's slice within that window. Measurement against representative tenant data is owned by #471's measurement gate (which already requires p50/p95 numbers in the PR description).
- **Slider movement** does not re-run the window function. It uses cutoffs cached from the menu-load pass (#471's existing design caches the four percentile cutoffs after the first menu load). Each slider stop corresponds to either:
  - a cached `baseline_score` threshold + client-side filter over already-fetched rows, or
  - a per-kind `raw_score` threshold derived from the menu-load ranking, used in `WHERE kind = :k AND raw_score >= :cached_kind_cutoff` against an index on `(kind, raw_score DESC, event_time DESC)`. The kind-first, raw_score-next order keeps the cutoff range index-resolved (`event_time` becomes a residual filter applied after the index seek). This index is added by the same migration that adds the `raw_score` column (§9 schema requirements). For very long active windows where the residual `event_time` filter dominates, the existing `(event_time DESC)` index remains an alternative the planner can pick — measurement (§12 / #471) decides per query shape.
- **The choice between the two slider strategies** is owned by #471's measurement: if the menu-load CUME_DIST pass and cached client-side filtering hit the latency targets, no per-stop SELECT is needed; if not, the per-kind raw-score threshold path is used. Either way the contract above — cutoffs cached at menu load, slider movement not triggering a fresh window function — holds.
- **Eventually, if both strategies miss latency targets** at production scale, the cadence runner can periodically refresh the pre-existing `baseline_score` column as a denormalized cache; the column then carries the same value as `CUME_DIST()` would, but stale by up to one cadence interval. This is an implementation choice the RFC permits but does not require.

The slider's widest position ("All" in #471) is bounded by what the cadence threshold has already brought into corpus A; loosening beyond that is a cadence-threshold tuning concern (#456), not a slider concern.

## §7. Statistics window

The window-level *cadence-time* selectors — S1 percentile rank, S3 recurring, S4 correlated — run against three concurrent window lengths at INSERT:

- 7-day window
- 14-day window
- 30-day window

Per-window selector outputs are combined via **max** within a single selector (the strongest signal across the three windows wins for that selector); selector union across selectors remains the weighted sum of §3.

Slot-allocation aggregates (`normalized_volume`, `normalized_top_confidence`, §4) operate at menu read time over the **user-active menu window** rather than the three statistics windows. The user picks the period; slot allocation reflects activity in exactly that period. This is a separate concept from the statistics windows above, which are an INSERT-time scoring artifact.

### Statistics source

The cadence-time GROUP BYs for S1/S3/S4 use `observed_event_meta` (#456) on the customer's tenant DB. NOT `baseline_triaged_event` — that would create a circular selection bias. The slot-allocation aggregates (§4) read `baseline_triaged_event` directly, where post-`BlockList*` filtering already matches the slot-allocation denominator. `review` is never asked to compute aggregates from either path; its RocksDB key layout is not optimized for arbitrary-dimension grouping.

### Cold-start

A window activates only once that much wall-clock time has elapsed since deployment. The 7d window is available 7 days after first ingest; 14d at 14 days; 30d at 30 days. Before activation, the corresponding window's signals contribute 0.

This makes cold-start a pure function of elapsed time. No row-count threshold is needed — a 7d window with 7 days of low-volume data is still meaningful (it correctly reflects the customer's actual activity), whereas a 30d window with only 2 days of data is meaningless regardless of row count. Time is the right proxy.

Per-event selectors (S2 severe, `UNLABELED_BONUS`) are unaffected by cold-start; they fire on every event from day one.

## §8. Score computation timing

**Decision: per-event raw_score evaluated at cadence INSERT and persisted on `baseline_triaged_event.raw_score`. baseline_score (the kind-normalized percentile rank) is computed at read time as a window function over raw_score (§3). No persisted pattern tables. No re-scoring of `raw_score` at read time.**

Concretely, when the cadence pipeline (§481) processes a new event:

1. The event is appended to `observed_event_meta` (the unbiased denominator) along with its peers in the same cadence batch.
2. For each event in the batch, the pipeline computes s1 / s3 / s4 by `GROUP BY` against `observed_event_meta` filtered to the active statistics window (§7) and the relevant grouping keys. s2 and `UNLABELED_BONUS` need no aggregation.
3. The weighted sum `raw_score(event)` is written to `baseline_triaged_event` along with `selector_tags`. Once written, it is not updated within its `baseline_version`.

Rationale:

- `raw_score` is order-independent: a row's stored value depends only on its own data and on `observed_event_meta` history at that moment, not on what other rows happen to be in `baseline_triaged_event` already. The kind-normalization step that does depend on the cohort is deferred to read time exactly so insertion order cannot distort it (§3 stored score).
- The relevant `observed_event_meta` indexes for the cadence-time GROUP BY are `event_time DESC` (the time-window slice) and `(kind, event_time DESC)` (kind-filtered window). The schema has no `asset` column; the asset-pair stand-in is `(orig_addr, resp_addr)` (and `orig_addr` for S4's per-asset grouping). The hash aggregate on `(orig_addr, resp_addr)` or `(orig_addr, kind)` runs over the kind/time-filtered slice; planner choice is verified during measurement (§12).
- Persisted pattern tables would add a separate write path, a retention concern, and a `baseline_version` migration story for what is already a bounded, schedulable computation inside the cadence runner.
- `raw_score` drift from later peer events: snapshots on `baseline_triaged_event.raw_score` are not retroactively updated when new peer events arrive in `observed_event_meta` and would change S3 / S4 / S1 percentile rank for already-inserted rows. The exposure bound depends on the user's active menu window, not on a single uniform "expiry":

  | Active menu window | Drift exposure for visible rows |
  |---|---|
  | Last 7d / 14d / 30d (typical menu use, per #458) | bounded to that window's age |
  | Up to 180d (corpus A retention is 180d per `migrations/customer/0003_baseline_corpus_a.sql`; `observed_event_meta` is only 30d) | up to 180d in the worst case — and beyond 30d the `observed_event_meta` history that produced the score has itself rolled over, so re-scoring is not even possible from current state |

  In other words, raw_score snapshots remain stable **within** their `baseline_version`, but the older a row gets the more its raw_score reflects state-of-the-world at its INSERT time rather than now. Mass re-scoring is explicitly not part of the design. If a future requirement makes long-window drift unacceptable, the mitigation is either tighter retention on `baseline_triaged_event` or a `baseline_version` bump that triggers natural turnover — the algorithm shape above does not change.

If measurement on representative production data shows the cadence-time aggregation cost is unacceptable, the fallback is a follow-up RFC introducing per-cadence-run pattern caches; the algorithm shape above (continuous selectors, weighted sum, read-time kind-normalized rank) does not change, only where the GROUP BY result lives.

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
| `R` | S3 saturation cap (additional repeats past which s3 stays at 1.0) | 10 |
| `C` | S4 saturation cap (additional categories past which s4 stays at 1.0) | 4 |

S1 needs no saturation cap — its output is already a percentile rank in `[0, 1]`. S2 and `UNLABELED_BONUS` are binary and saturated by definition.

### Slot allocation tag normalization (§4)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `MAX_TAGS` | maximum distinct selector tags the cadence pipeline can emit (denominator for `normalized_top_confidence` average) | 5 |

The five tags are `S1-high`, `S2-severe`, `S3-recurring`, `S4-correlated`, `unlabeled-cluster`. If a future selector adds a tag, `MAX_TAGS` increases and a `baseline_version` bump follows.

`selector_tags` content (the analyst-visible label set) parallels but is not identical to selector contributions to `baseline_score`: a tag is emitted when a selector's value exceeds an implementation-level "this fired meaningfully" threshold (e.g. `s1 > 0.85` → `"S1-high"`, `s3 > 0.5` → `"S3-recurring"`). Exact tag thresholds are implementation details for the score formula but they do affect `MAX_TAGS` denominator semantics — different thresholds produce different average tag counts. Tag thresholds are therefore part of `baseline_version` (open question 5).

### Selector membership lists (§3)

`CRITICAL_CATEGORIES` — the only membership list referenced by the revised selectors (S2 fires when `category(event) ∈ CRITICAL_CATEGORIES`). Initial contents are populated from existing detection metadata at code time and reviewed with ops before merge. Stored in source code (e.g., `src/lib/triage/baseline/categories.ts`), not in the database; changing the list requires a `baseline_version` bump.

`FAVORED_KINDS` (§5) is a related membership list affecting per-kind slot allocation, not within-kind selector firing; it lives next to `CRITICAL_CATEGORIES` and follows the same source-code + version-bump rules.

### Slot allocation (§4)

| Symbol | Meaning | Provisional value |
|---|---|---|
| `base_share` | floor share per kind | 0.02 |
| `α` | volume × signal-richness coefficient | 1.0 |
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

### Schema requirements (additions to `baseline_triaged_event`)

The algorithm requires two schema-level guarantees that are not in the current `migrations/customer/0003_baseline_corpus_a.sql`. The implementation PR for #462 carries the migration that adds them; both are additive and do not break existing readers.

| Column / constraint | Required form | Reason |
|---|---|---|
| `raw_score` | new `DOUBLE PRECISION NOT NULL` column | Persisted weighted sum from §3, used as the input to read-time `CUME_DIST()` that produces `baseline_score`. `NOT NULL` is enforced from the migration onward; per-row `baseline_version` tracks which scoring algorithm produced the value. |
| `selector_tags` | tightened to `NOT NULL DEFAULT '{}'` | The `coalesce(cardinality(selector_tags), 0)` guard in §4 covers the formula at read time, but tightening the column at INSERT removes the NULL state at the source and lets future readers omit defensive coalescing. |
| index on `(kind, raw_score DESC, event_time DESC)` | new btree index | Required by §11's per-kind `raw_score` threshold strategy for slider movement. Column order is `kind` (equality) → `raw_score` (range, the load-bearing predicate at slider stops) → `event_time` (residual, available for ordering within a kind+raw_score slice). Putting `event_time` before `raw_score` would block index-resolution of the range cutoff, since a range column at index position N stops the planner from using index columns N+1 onward for further range filtering. The pre-existing `(event_time DESC, baseline_score DESC)` index does not apply once `baseline_score` is no longer the persisted column. |

**Backfill contract for existing rows.** When the migration runs against a tenant DB that already holds Phase 1.A rows from `0003_baseline_corpus_a.sql`, the rows must be filled before `NOT NULL` is enforced:

1. `UPDATE baseline_triaged_event SET selector_tags = '{}' WHERE selector_tags IS NULL` — Phase 1.A had no selectors, so the empty array is the truthful value.
2. `UPDATE baseline_triaged_event SET raw_score = baseline_score WHERE raw_score IS NULL` — Phase 1.A's `baseline_score` was a constant placeholder, and using the same value for `raw_score` preserves the existing relative ordering for the few hours/days until those rows age out under the 30-day typical-menu-window or are turned over by the next `baseline_version` bump (which the same migration triggers — see §10). No semantic claim is made that backfilled `raw_score` values are comparable to genuine Phase 1.B `raw_score`; the per-row `baseline_version` distinguishes the regimes.
3. `ALTER TABLE … ALTER COLUMN … SET NOT NULL` — both columns now safe.

`baseline_score` is **not** added by this migration. It is computed at read time over `raw_score` per §3. The pre-existing `baseline_score DOUBLE PRECISION` column on `baseline_triaged_event` may stay (denormalized cache, refreshed by the cadence runner if measurement requires it) or be dropped in a later migration once Phase 1.B reads no longer depend on it; that is an implementation choice driven by §471's measurement gate, not a contract of this RFC.

### Selector evaluation timing

All selectors are evaluated at cadence INSERT time (§8) using `observed_event_meta` history at that moment. `raw_score(event)` and `selector_tags(event)` are persisted on `baseline_triaged_event` and not updated within their `baseline_version`. `baseline_score` is computed at read time from `raw_score` (§3 stored score) and is therefore not stored as part of this RFC's contract. The read path needs no joins and never touches `observed_event_meta` — both per-event values (`raw_score`, `selector_tags`, computed `baseline_score`) and per-kind slot-allocation aggregates (volume + average `selector_tags` length, §4) come from `baseline_triaged_event` alone.

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

5. **`selector_tags` content and tag thresholds.** The schema gives `selector_tags TEXT[]`; tag membership is decided by per-selector "fired meaningfully" thresholds set in code (§9). Tag thresholds are now load-bearing — they affect both per-event analyst readability **and** `normalized_top_confidence` in slot allocation (§4 reads average tag count). Tag-threshold changes should therefore bump `baseline_version`. Ops review confirms the threshold values before merge.

6. **`selector_tags` length as the signal-richness proxy (§4).** `normalized_top_confidence` is computed as average `selector_tags` array length divided by `MAX_TAGS`. This is a coarse proxy: it counts how many of the algorithm's selectors fire on a typical event in the kind, but does not weight them by per-selector value or distinguish "S2-severe alone" from "S1-high + S3-recurring + S4-correlated". The newly-required `raw_score` column (§9 schema requirements) makes a finer formulation cheap to swap in — e.g., `avg(raw_score) / MAX_POSSIBLE_SCORE` over the same `baseline_triaged_event` slice — without changing the read shape (still single-table, still slot-allocation-only). Whether the coarse tag-length proxy is good enough or whether the implementation should switch to `raw_score` is left for ops review on representative tenant data.
