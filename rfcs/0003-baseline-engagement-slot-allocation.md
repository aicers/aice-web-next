# RFC 0003: Baseline engagement — Phase 2 slot allocation

- Status: **Draft**
- Authors: @sehkone
- Tracks: [#593](https://github.com/aicers/aice-web-next/issues/593)
- Implements via: [#589](https://github.com/aicers/aice-web-next/issues/589) (this RFC is the design; #589 is the implementation)
- Related: [#485](https://github.com/aicers/aice-web-next/issues/485) (epic), [#588](https://github.com/aicers/aice-web-next/issues/588) (Phase 1 capture), [#462](https://github.com/aicers/aice-web-next/issues/462) ([RFC 0001](0001-baseline-algorithm.md) — baseline algorithm), [#471](https://github.com/aicers/aice-web-next/issues/471) (strictness slider), [#472](https://github.com/aicers/aice-web-next/issues/472) (snapshot audit)

## Summary

Phase 2 of the [#485](https://github.com/aicers/aice-web-next/issues/485) epic adds an **engagement term** to RFC 0001's slot-share formula so the Triage menu's per-bucket quota adapts to which kinds analysts actually click on. The engagement signal is computed from #588's capture tables (`engagement_impression` + `engagement_action`) as an **exposure-normalized rate per slot bucket**, bounded and damped by four exploration guardrails, and injected into `composeMenu` as an additional pure-function input.

The engagement term is **orthogonal** to RFC 0001's `favored_bonus` (it does not replace or amplify the prior) and is **kill-switchable** via a coefficient `γ` that defaults to `0` at first ship — making the initial Phase 2 deployment behavior-equivalent to RFC 0001 while letting #589 land in production and accumulate the engagement aggregates the calibration retune will use.

This RFC fixes the **structure** (formula shape, action set, denominator, guardrails, snapshot contract, `composeMenu` injection). Final **numeric** parameter values (`γ`, per-bucket floors, decay constants, exploration share, cold-start thresholds) ship via a `baseline_version` bump amendment **after** #588 has run in a production tenant with human-analyst traffic and the engagement distribution is observed. Initial substrate-informed conservative defaults are derived from a 30-day / 200,000-row snapshot of the test-clumit `customer_customer_a_8983d4` corpus, recorded in §12.

## Motivation

RFC 0001 §4–§5 produce per-bucket slot quotas from `base_share`, `normalized_volume × normalized_top_confidence`, and `favored_bonus`. None of those terms know which buckets analysts find *useful*. A bucket that is high-volume and signal-rich may be ignored by every analyst; a bucket that is low-volume and signal-poor may be the one every analyst clicks first.

Phase 1 (#588) captures the data needed to close that loop: for every menu load, every surfaced row is recorded as an impression, and every click is recorded as an action. The exposure-normalized engagement rate per bucket is the unbiased measure of "what analysts found useful", and Phase 2 lets that signal influence slot share.

Three constraints shape the design:

1. **Bandit-style feedback loops are the primary failure mode** ([#588 "Why capture-first"](https://github.com/aicers/aice-web-next/issues/588)). A bucket surfaced *because* engagement was high gets more impressions, which inflate the next window's denominator. Without damping, the system locks onto whatever the first-week traffic happens to hit. §5 specifies the four guardrails that mitigate this.
2. **Capture metadata must be honored, not averaged away.** #588 separates `shown_by ∈ {quota, fallback, story_protected}` and threads `strictness_stop` onto every impression *because* Phase 2 needs to filter and segment by these. §2.3 takes explicit positions on both.
3. **Slot allocation is per-bucket, not per-kind.** RFC 0001 §5.1 fixes the allocation unit at `slot_bucket = (kind, is_unlabeled)` (see [`slotBucket()`](../src/lib/triage/baseline/compose.mjs#L59)); the favored prior is [`FAVORED_BUCKETS`](0001-baseline-algorithm.md), and `unlabeled-HttpThreat` is its own bucket. This RFC writes "per-bucket" wherever it would otherwise have written "per-kind".

## Pipeline (where engagement enters)

```
At cadence INSERT (per event):                        — unchanged from RFC 0001 §3
   ├─ (1) hard-exclude Blocklist*
   ├─ (2) determine kind
   └─ (3) compute raw_score, selector_tags            persisted on baseline_triaged_event

At menu read (per active window):                     — RFC 0001 §3 with one addition
   ├─ (4) baseline_score = CUME_DIST() OVER (...)     unchanged
   ├─ (4½) ENGAGEMENT AGGREGATE                       NEW: SELECT per-bucket
   │       (engagement_rate, impression_count,            engagement_rate and
   │        is_new_bucket, last_engaged_at)              impression_count over
   │                                                      the active window from
   │                                                      engagement_impression
   │                                                      ⋈ engagement_action;
   │                                                      see §7 for the SQL
   │                                                      shape and §3 for the
   │                                                      window choice.
   │
   ├─ (5) compute per-bucket quotas                   slot_share now includes the
   │      slot_share(b) = base_share                    γ · engagement_signal(b)
   │                    + α · norm_volume(b)              term; see §4.
   │                          · norm_top_conf(b)
   │                    + favored_bonus(b)
   │                    + γ · engagement_signal(b)   NEW
   │
   ├─ (6) merge per-bucket cutoff-and-quota           unchanged
   └─ (7) MIN_NONZERO_FLOOR fallback                  unchanged
```

The engagement aggregate is computed by the caller and **injected into `composeMenu`** as an additional `bucketEngagement` input (§9); `composeMenu` itself stays pure. When `bucketEngagement` is `undefined` (legacy callers, unit tests, kill-switch), `γ = 0` collapses the new term to zero and behavior is RFC 0001-equivalent.

---

## §1. Terminology — bucket, not kind

The unit of slot allocation throughout this RFC is the **slot bucket**, defined exactly as in RFC 0001 §5.1:

```
slot_bucket = (kind, is_unlabeled)
where is_unlabeled := (kind == 'HttpThreat' && 'unlabeled' ∈ selector_tags)
```

The bucket key produced by [`bucketKey()`](../src/lib/triage/baseline/compose.mjs#L66) is `"${kind}:${is_unlabeled}"` (e.g. `"HttpThreat:true"` for unlabeled-HttpThreat). [`FAVORED_BUCKETS`](../src/lib/triage/baseline/compose.mjs#L36) is the prior, *not* `FAVORED_KINDS` — `unlabeled-HttpThreat` is favored, plain `HttpThreat` is not.

Where this RFC must distinguish a raw `kind` from a `slot_bucket` (e.g. when joining row-bound action rows that only carry `kind`), §2.4 specifies the reconstruction path. Elsewhere, "per-bucket" means strictly `slot_bucket`.

`engagement_impression.slot_bucket` already stores the bucket key per #588 — no reconstruction is needed for impressions. Reconstruction is needed only for `engagement_action`, which carries `kind` but not `slot_bucket`.

---

## §2. Engagement signal model

### §2.1 Action set

The engagement numerator counts only actions that:

(a) **identify a slot bucket** (directly or through a recoverable join), and
(b) **carry a defensible "this event was useful" semantics** for per-bucket slot allocation.

Applying both filters to #588's five action types:

| Action type           | `kind` populated? | Has bucket attribution? | Counts toward slot allocation? |
|-----------------------|-------------------|-------------------------|--------------------------------|
| `pivot_click`         | yes               | yes (via `event_key`)   | **yes**                        |
| `story_pivot_click`   | yes               | yes (via `event_key`)   | **conditional** (see §10.1)    |
| `asset_select`        | NULL              | no (selects an asset address, not an event) | **no**          |
| `exclusion_create`    | NULL              | no (creates an exclusion row, not an event interaction) | **no** |
| `strictness_change`   | NULL              | no (slider state, not row-level) | **no**                |

`asset_select`, `exclusion_create`, and `strictness_change` are not engagement *with a bucket* — they are engagement with surfaces orthogonal to per-bucket allocation. They remain in #588's capture for future use (asset-pattern feedback, exclusion-rate audit, strictness-distribution analysis) but do **not** feed Phase 2's slot-share term.

`story_pivot_click` is conditional pending §10.1's resolution. The default treatment in §2.2 is to count it equally with `pivot_click` for v1, with the option to flip to "impression-only" if §10.1's recommendation lands the other way.

### §2.2 Numerator semantics

For each slot bucket `b` and time window `W`, the engagement numerator is:

```
engagement_count(b, W) =
    count of distinct (menu_load_id, event_key) pairs in W such that:
        - engagement_action.event_key ∈ engagement_impression.event_key
            in the same (menu_load_id, event_key) row pair,
        - action_type ∈ ENGAGED_ACTIONS,
        - the matched impression has slot_bucket = b,
        - the matched impression has shown_by ∈ INCLUDED_SHOWN_BY,
        - period attribution rule (§2.3) holds.
```

**Per-action weighting.** All actions in `ENGAGED_ACTIONS` count equally (weight = 1) for v1. Rationale: until the engagement-rate distribution is observed (calibration retune), introducing a per-action weight is premature optimization — the weight assignment is itself a parameter requiring empirical justification. The Phase 3 RFC (#590) re-examines per-action weighting as part of within-kind ranking.

**Dedupe.** Engagement is counted once per `(menu_load_id, event_key)` pair, regardless of how many actions fire on the same impression. Multi-click within the same menu load reflects analyst exploration of one event, not multiple "useful" signals — collapsing to a single engagement matches the per-impression denominator unit and prevents a single noisy menu load from dominating an aggregate.

**Decision: add `menu_load_id` to `engagement_action` via expand migration in #589.** This preserves the `(menu_load_id, event_key)` dedupe key shape that matches `engagement_impression`'s PK. Alternatives — hour-bucket dedupe `(event_key, account_id_hmac, date_trunc('hour', created_at))` or no dedupe — lose data on session-boundary replays or let noisy clicks dominate the rate. Migration ordering: #588's base schema lands first; #589's expand adds the column and threads it through `engagement_action`'s POST ingest path. Pre-existing action rows captured between #588's deploy and #589's expand get `NULL` for `menu_load_id` and are silently excluded from the §7 aggregate by the JOIN (no backfill — older action rows cannot be retroactively attributed to a specific menu load).

**Bucket attribution for row-bound actions.** `engagement_action.kind` is the raw `kind`, not the `slot_bucket`. To attribute a `pivot_click` on an `HttpThreat` event correctly to either `HttpThreat:false` or `HttpThreat:true` (unlabeled), the action row is **joined to its impression row on `event_key`** and the impression's `slot_bucket` is the authoritative source. The numerator query shape is therefore:

```sql
SELECT
    i.slot_bucket,
    COUNT(DISTINCT (i.menu_load_id, i.event_key)) AS engagement_count
FROM engagement_impression i
JOIN engagement_action a
    ON a.event_key = i.event_key                          -- row-bound action carries event_key
   AND a.created_at >= i.created_at                       -- action followed surfacing
   AND a.created_at  < i.created_at + INTERVAL '24 hours' -- bounded session window
WHERE i.created_at >= NOW() - INTERVAL '<window>'
  AND a.action_type IN ('pivot_click' /*, 'story_pivot_click' per §10.1 */)
  AND i.shown_by IN ('quota' /*, see §2.3 */)
GROUP BY i.slot_bucket;
```

The 24-hour session window bounds the join — an action that fires more than a day after the impression is not credibly attributable to that menu load. The session window itself is a parameter (default 24h, substrate-informed in §12).

When the same `event_key` appears in multiple impression batches (the same event surfaced across menu loads), the action attaches to the **earliest impression preceding it** — `DISTINCT ON (a.id) ... ORDER BY i.created_at ASC` semantics. The intent is to count one engagement per click, not one per (click × impression).

### §2.3 Denominator definition

The denominator is the per-bucket **impression count** over the same window, filtered by the same `shown_by` and `strictness_stop` rules as the numerator:

```sql
SELECT slot_bucket, COUNT(*) AS impression_count
FROM engagement_impression
WHERE created_at >= NOW() - INTERVAL '<window>'
  AND shown_by IN (...)
GROUP BY slot_bucket;
```

`engagement_rate(b) = engagement_count(b) / impression_count(b)`, clipped to `[0, 1]`.

**Raw impressions vs eligible-but-not-surfaced.** v1 uses **raw impressions surfaced** (rows in `engagement_impression`) as the denominator. This matches #588's capture shape exactly — no additional instrumentation required — and matches the semantics of "for the buckets we actually showed, how often did analysts engage."

> The alternative denominator — "menu loads where bucket `b` *was eligible* (had ≥1 candidate above cutoff) regardless of whether it was surfaced under quota" — would let low-volume buckets that are routinely crowded out by quota rounding still accumulate denominator mass. It is the **correct** denominator if the goal is "what fraction of opportunities did this bucket convert", but it requires capturing an eligibility log alongside the impression batch, which #588 does not produce. The cost of adding it (a second per-menu-load batch carrying every above-cutoff candidate, multiplying capture volume) is not justified at v1.
>
> Phase 3 (#590) may revisit if measurement shows low-volume buckets are starved by the raw-impression denominator.

**`shown_by` filtering — `INCLUDED_SHOWN_BY`.** v1 uses `INCLUDED_SHOWN_BY = {'quota'}`. Both `fallback` and `story_protected` impressions are **excluded from both numerator and denominator**:

- `fallback` rows were surfaced because the cutoff produced too few candidates — they did not earn their slot through the engagement-model formula, and counting their clicks would credit the engagement model for a slot the fallback path produced. Symmetric exclusion from numerator and denominator keeps the rate definitionally honest.
- `story_protected` rows were surfaced by branch B's force-union, also independent of the engagement-driven quota. Same rationale.

This is the most conservative filter and the most defensible against the recursive-bias failure mode #588 was built to detect.

> If observation reveals that fallback rates are high (i.e. the menu is routinely fallback-dominated), Phase 3 may want to include them — but at that point the right fix is more candidates above cutoff, not engagement crediting for the fallback path. Hold the line at v1.

**`strictness_stop` segmentation.** Strictness changes **exposure probability**, not just the cutoff: each stop carries a per-stop [`defaultNMultiplier`](../src/lib/triage/strictness/stops.ts#L51) (0.25 → 2), and the `"all"` stop [lifts the per-bucket quota entirely](../src/lib/triage/baseline/compose.mjs#L159). Pooling denominators across stops would treat one impression at `top5` (smaller menu, more attention per row) as equivalent to one at `top80` (larger menu, attention diluted) — a known confound.

v1 segments the aggregate by `strictness_stop` and reports the **engagement_rate at each stop separately**. The composeMenu input carries a per-stop engagement aggregate; the read path looks up the stop matching the current request and applies it. The `"all"` stop is excluded from aggregation (it lifts the quota, so the engagement term has nothing to weight — the assembled rows are everything above cutoff). Cross-stop comparison is **not** performed by the formula; it is a calibration / observability concern only.

> Pooling across stops with a `defaultNMultiplier`-weighted average is the obvious alternative. It is rejected for v1 because the multiplier captures the menu-size effect but not the analyst-attention effect (an analyst seeing 50 rows reads each less carefully than one seeing 10), and that second effect is not modeled. Per-stop segmentation is the conservative choice that defers the question.

### §2.4 What an action does NOT see

- `engagement_action.kind` is **not** the source of truth for slot bucket — `engagement_impression.slot_bucket` is (§2.2 join).
- `engagement_action` rows that arrive without a matching `engagement_impression` (e.g. an action fired against an event that was retained past the impression's 90-day retention) are **dropped from the aggregate**, not credited. The exposure-normalized rate is undefined without a denominator row.
- Actions whose `event_key` is `NULL` (`asset_select` / `exclusion_create` / `strictness_change`) are not joined and not counted (§2.1).

---

## §3. Aggregate window bounds

The engagement aggregate is computed over the **same 7d / 14d / 30d concurrent windows** as RFC 0001 §7, activated by elapsed wall-clock time since deployment:

```
window ∈ {7d, 14d, 30d}
active(window) iff (now - engagement_capture_started_at) >= window
```

`engagement_capture_started_at` is the first `created_at` in `engagement_impression` per tenant. Per-tenant, not global — a tenant's engagement model warms up on the tenant's own clock, the same way RFC 0001's statistics windows do.

Rationale for window reuse (rather than an independent cadence):

- **Time-axis coherence.** RFC 0001's `normalized_volume(b, window)` and `normalized_top_confidence(b, window)` already condition on a window. Reading engagement on a *different* cadence introduces "which window does composeMenu read this time" — a needless source of inconsistency between two terms that share a slot-share formula.
- **Materialization parity.** §7 makes the same read-time choice as RFC 0001 §8 — both compute on every menu load. A shared cadence keeps the SQL cost predictable.
- **Calibration parity.** Retune analyses (§11) are easier to interpret when the engagement window matches the baseline statistics window.

When multiple windows are active simultaneously, the **longest active window with at least one tenant-wide engagement signal** is used. The fallback chain is `30d → 14d → 7d → cold-start (§6)`. This biases toward the most-stable signal once the tenant is mature, while letting newer tenants and newer buckets be responsive on the 7d window.

---

## §4. Slot share formula

The engagement term is added **orthogonally** to RFC 0001 §4's formula:

```
slot_share(b) = base_share
              + α · normalized_volume(b, W) · normalized_top_confidence(b, W)
              + favored_bonus(b)
              + γ · engagement_signal(b, W)
```

Where:

- `engagement_signal(b, W)` is the per-bucket exposure-normalized rate (§2.3) **after** the guardrails of §5 (new-bucket cap, decay, floor) are applied, **clipped to `[0, 1]`**, and zero when the bucket lacks an impression denominator (§2.4) or the tenant is in cold-start (§6).
- `γ ∈ [0, 1]` is the engagement weight. **Initial value: `γ = 0` (kill-switch off).** First production ship is RFC 0001-equivalent; the calibration retune (§11) sets `γ > 0`.

**Orthogonality decision.** The engagement term **does not replace** `favored_bonus(b)` and **does not multiply** any existing term. The three reasons:

1. **`favored_bonus` is a prior, not a measurement** ([RFC 0001 §5.1](0001-baseline-algorithm.md)). Replacing it with engagement would conflate "ops asserts this bucket is important regardless of activity" (the prior) with "analysts clicked this bucket in the last window" (the measurement). A favored bucket that goes quiet for a window should still keep its prior bonus — engagement going to zero should not strip the prior.
2. **Multiplicative coupling makes kill-switch non-trivial.** With `γ · engagement(b) · (other_terms)`, the engagement term cannot be cleanly disabled without rewriting the formula. Additive `γ · engagement(b)` collapses to zero by setting `γ = 0`.
3. **Calibration is independent.** Tuning `γ` against an observed engagement-rate distribution is a one-variable optimization. Coupling it with `favored_bonus` or `normalized_volume × normalized_top_confidence` would require joint tuning.

The "favored buckets are a prior, not a whitelist" framing from RFC 0001 §5.1 stays intact: a non-favored bucket whose engagement is high still earns share through `γ · engagement(b)` even though `favored_bonus(b) = 0`.

**Normalization.** `engagement_signal(b)` is already in `[0, 1]` (it is a rate after clipping), so the per-bucket shares remain on comparable scales without further normalization. The largest-remainder method in [`computeBucketQuotas`](../src/lib/triage/baseline/compose.mjs#L91) operates on the share values regardless of magnitude.

---

## §5. Exploration guardrails

The four guardrails required by #593. All four are **layered**, not merged into a single parameter: each one targets a distinct failure mode and is independently tunable.

### §5.1 Per-bucket floor

Every bucket — favored or not, engaged or not — gets at least `base_share` (RFC 0001 §5). The engagement term **adds** to this floor; it never subtracts:

```
slot_share(b) ≥ base_share   for all b
```

This is RFC 0001 §5's invariant carried forward, not a new rule. The engagement term being additive (§4) preserves it automatically — `γ · engagement(b) ≥ 0` for all `(γ, engagement(b))` in `[0, 1] × [0, 1]`.

A new bucket appearing for the first time (no prior impressions, no prior engagement) still gets `base_share` and is therefore discoverable on its first menu load. Engagement cannot starve a bucket out of existence.

### §5.2 New-bucket cap on engagement influence

A bucket with too few impressions cannot supply a statistically meaningful engagement rate — the rate is dominated by noise from individual clicks. Until per-bucket impression count exceeds a threshold, the engagement term is suppressed for that bucket:

```
γ_effective(b, W) =
    0              if impression_count(b, W) < N_min
    γ              otherwise
```

`N_min` is the per-bucket impression floor.

**Initial value: `N_min = 100`.** Substrate-informed: from the test-clumit corpus (30d, 200k rows, 11 buckets — see §12), the lowest-volume bucket (`SuspiciousTlsTraffic`) reaches 100 impressions within ~12 hours of impression flow; the largest (`unlabeled-HttpThreat`) saturates within hours. Below 100 the per-bucket rate's standard error exceeds ~10%. Retune candidates (§11): 50 (more responsive, more noise) or 500 (slower to engage, more stable).

A bucket suppressed by this gate still appears in the menu via RFC 0001's existing terms — only the engagement contribution is zeroed.

### §5.3 Engagement decay / damping

The engagement signal uses **exponentially-weighted moving average (EWMA)** within the active window, with half-life equal to the active window's natural lookback:

```
engagement_signal_decayed(b, W) =
    Σ_i (1/2)^((now - created_at_i) / half_life) · engagement_event_i(b)
    --------------------------------------------------------------------
    Σ_i (1/2)^((now - created_at_i) / half_life) · impression_event_i(b)
```

Where `half_life = W / 2` (so a 7d window has a 3.5d half-life, 14d → 7d, 30d → 15d).

Rationale:
- A single window of engagement counted uniformly lets a one-day spike dominate the entire window. EWMA weights recent days more heavily without abandoning earlier data, so the signal responds without thrashing.
- Half-life equal to window/2 keeps the effective sample size near half the window; a smaller half-life produces noisier rates, larger half-life converges back toward uniform.
- EWMA is computable in one SQL pass with `EXP(-ln2 · age / half_life)` weights — no maintenance state.

### §5.4 Fixed exploration share

A fixed fraction `ε ∈ [0, 1]` of `default_N` is reserved for buckets whose engagement signal is in the **bottom decile** of the active window:

```
exploration_slots = round(ε · default_N)
```

These slots are allocated to the lowest-engagement buckets in proportion to their `base_share`, before the engagement-driven allocation runs over the remaining `(1 - ε) · default_N`. The intent is to guarantee that buckets the engagement model deprioritizes still appear in the menu, so the model has fresh data to update against (and so an under-engaged bucket can recover if analyst preference shifts).

**Initial value: `ε = 0.1`.** With 11 buckets in the test-clumit substrate (§12) and `default_N` typically in 10–30, `ε = 0.1` reserves ~1 slot per menu load for the lowest-decile bucket. Retune candidates (§11): 0.05 (less exploration, faster convergence) or 0.2 (more exploration, more stable distribution).

The exploration share is implemented in `composeMenu` as a pre-allocation step before `computeBucketQuotas` runs; see §9.

---

## §6. Tenant-level cold-start

Distinct from §5.2's per-bucket cap. A tenant with **no engagement history at all** (newly onboarded, just deployed #588) has nothing to calibrate against. Until the tenant accumulates a baseline of impressions:

```
γ_tenant(t) =
    0   if total_impression_count(t, all buckets, 30d) < M_tenant
    γ   otherwise
```

The tenant runs on RFC 0001 alone until `M_tenant` impressions accumulate, then the engagement term activates. This avoids letting a tenant's first analyst's first hour of clicks lock in a degenerate distribution.

**Initial value: `M_tenant = 1,000 impressions`.** test-clumit's `customer_customer_a_8983d4` would reach 1,000 impressions in well under a day at any plausible menu-load rate, so any first-week active tenant clears this. Retune candidates (§11): 100 (faster activation, less stable cold-start) or 10,000 (slower, more conservative).

The transition is **not** a `baseline_version` bump — it is a per-tenant runtime check. The `engagement_model_version` snapshot (§8) records the formula and parameters, not whether the tenant has crossed the cold-start gate. The audit trail for "this menu was produced under cold-start" is the impression count at the time, recoverable from `engagement_impression`.

---

## §7. Materialization strategy

**Read-time aggregation per menu load**, computed by the caller (the menu loader), passed into `composeMenu` as `bucketEngagement` (§9). No materialized table, no periodic job, no extra cadence.

Rationale, mirroring RFC 0001 §8's precedent:

- The aggregate SQL (§2.2 numerator, §2.3 denominator) is one `GROUP BY` per side over `engagement_impression` and `engagement_action`. With #588's indexes (`engagement_impression_kind_bucket_idx`, `engagement_action_event_key_idx`), substrate analysis on test-clumit's 30d / 200k row corpus would produce a worst-case sub-second cost — well within the menu-load budget.
- The alternative (a materialized periodic rollup) adds operational state (a job, freshness lag, an inconsistency window between the rollup and the live tables) for an optimization that has not yet been measured to be necessary.

The materialization decision **inherits RFC 0001 §8's revisit trigger**: if measurement on production-shape Phase 2 data shows per-load aggregation cost is unacceptable, file a follow-up RFC introducing periodic materialization with a freshness-vs-cost trade-off analysis. Until then, keep the read path simple.

The aggregate SQL produced for v1 is roughly:

```sql
WITH window_bounds AS (
    SELECT NOW() - $1::INTERVAL AS lo,
           NOW()                AS hi
), impressions AS (
    SELECT i.slot_bucket,
           SUM(EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - i.created_at))
                          / $2::DOUBLE PRECISION)) AS weighted_imp
    FROM   engagement_impression i, window_bounds w
    WHERE  i.created_at >= w.lo
      AND  i.shown_by   = 'quota'
      AND  i.strictness_stop = $3
    GROUP  BY i.slot_bucket
), engagements AS (
    SELECT i.slot_bucket,
           SUM(EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - i.created_at))
                          / $2::DOUBLE PRECISION)) AS weighted_eng
    FROM   engagement_impression i
    JOIN   engagement_action a
           ON a.event_key = i.event_key
          AND a.created_at >= i.created_at
          AND a.created_at  < i.created_at + INTERVAL '24 hours'
    WHERE  i.created_at >= (SELECT lo FROM window_bounds)
      AND  i.shown_by   = 'quota'
      AND  i.strictness_stop = $3
      AND  a.action_type IN ('pivot_click' /*, 'story_pivot_click' */)
    GROUP  BY i.slot_bucket
)
SELECT  imp.slot_bucket,
        imp.weighted_imp                                    AS impression_count,
        COALESCE(eng.weighted_eng, 0) / imp.weighted_imp    AS engagement_rate
FROM    impressions imp
LEFT JOIN engagements eng USING (slot_bucket);
```

Parameters: `$1` window (e.g. `'14 days'`), `$2` half-life in seconds, `$3` strictness stop. The query produces one row per bucket present in the window; buckets absent from this result fall to the §6 cold-start path.

---

## §8. Versioning and reproducibility

### §8.1 `engagement_model_version`

A string tag bumped whenever **any** of the following changes:

- The slot-share formula (§4) — coefficient additions/removals.
- Any of the four guardrail parameters (§5): `N_min`, half-life formula, `ε`, the `INCLUDED_SHOWN_BY` set.
- The cold-start threshold `M_tenant` (§6).
- The active window selection rule (§3).
- The aggregate SQL shape (§7) — i.e. the definition of `engagement_signal(b)`.

The tag is independent of `baseline_version`. A `baseline_version` bump may or may not bump `engagement_model_version`; an `engagement_model_version` bump always bumps `baseline_version` (because the slot-share formula is part of the baseline algorithm contract).

### §8.2 `engagement_model_snapshot`

A new table in each customer-tenant DB, alongside #472's snapshot tables:

```sql
CREATE TABLE engagement_model_snapshot (
    version               TEXT         PRIMARY KEY,    -- engagement_model_version
    formula               JSONB        NOT NULL,       -- coefficients, guardrail params
    window_bounds         JSONB        NOT NULL,       -- {active_windows: [...], selection_rule: '...'}
    aggregate_sql_digest  TEXT         NOT NULL,       -- sha256 of the parametrized SQL template
    captured_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

`formula` payload captures every value the implementation reads from the engagement-model tunables module (the analog of #472's `baseline_version_snapshot.parameters` for baseline). Concretely: `γ`, `N_min`, half-life formula, `ε`, `INCLUDED_SHOWN_BY` set, `M_tenant`, `ENGAGED_ACTIONS` set, session-window hours.

`aggregate_sql_digest` captures the per-load aggregate query template so a future investigator can verify that the SQL behind a snapshot version was the SQL shipped with that version. The template — not a per-load filled query — is what changes when the formula changes.

`captured_at` is the first-observed timestamp; ON CONFLICT (version) DO NOTHING semantics (mirrors #472's pattern).

### §8.3 Reference from corpus rows

The audit lookup from a corpus row back to the engagement model that produced its menu placement requires **the engagement model version at menu-load time, not at corpus-insert time**. A `baseline_triaged_event` row is produced by cadence (no engagement model involved); its menu placement happens at read time when the engagement model is read into `composeMenu`. The two timestamps differ — corpus insert can predate engagement-model-version bumps by days.

Therefore:

- **`baseline_triaged_event` does NOT get a new `engagement_model_version` column** — it is not the right join surface.
- The audit substrate is `engagement_impression`: every impression row already carries `baseline_version` (per #588). v1 adds `engagement_model_version` to `engagement_impression` as a NEW column, populated by the menu loader at impression-batch write time.

```sql
-- expand migration in the #589 implementation:
ALTER TABLE engagement_impression
    ADD COLUMN engagement_model_version TEXT;

UPDATE engagement_impression
    SET engagement_model_version = 'phase2-v1'
    WHERE engagement_model_version IS NULL;

ALTER TABLE engagement_impression
    ALTER COLUMN engagement_model_version SET NOT NULL;
```

Lookups then resolve through `engagement_impression`:

```sql
SELECT s.formula, s.window_bounds, s.aggregate_sql_digest
FROM   engagement_impression i
JOIN   engagement_model_snapshot s ON s.version = i.engagement_model_version
WHERE  i.menu_load_id = :menu_load_id
  AND  i.event_key    = :event_key;
```

The `(menu_load_id, event_key)` PK on impressions gives O(1) lookup; one impression row per surfaced corpus row gives the per-row audit story.

**Decision: add `engagement_model_version` to `engagement_impression` via expand migration in #589.** Cleaner than carrying the version externally (e.g. in an audit log row) since the column lives at the same grain as the audit substrate (one row per surfaced corpus row). Migration ordering: #588's base schema lands first, then #589's expand migration adds the column and backfills `'phase2-v1'` for any pre-existing rows.

### §8.4 Retention

`engagement_model_snapshot` follows the same retention rule as #472's snapshot tables: retain as long as any referencing impression survives, plus a 30-day grace. Snapshot rows are tiny (one per version), so practical retention is "forever" — the cleanup sweep is defensive only.

The cleanup join target is `engagement_impression.engagement_model_version`; cleanup runs in the same internal cleanup sweep as #472's snapshot retention (the architecture pattern is reused, the predicate is new).

**Audit window bound.** The §8.3 lookup is bounded by the shorter of:
- **`engagement_impression` retention (90 days)** — set by #588's migration `0014_engagement_signals.sql`. After 90 days the impression row is gone, and with it the `engagement_model_version` reference for that menu placement.
- **`baseline_triaged_event` retention** — set by the cadence layer (RFC 0001 §7; typically 30–45 days).

Within those bounds the corpus row → impression → snapshot chain resolves; outside them, `engagement_impression.engagement_model_version IS NULL` (no row) is the expected lookup outcome and the audit caller surfaces "snapshot predates audit support" the same way #472's lookup does for pre-snapshot corpus rows. No extension of either retention is in scope.

---

## §9. `composeMenu` consumption contract

### §9.1 Input shape

```typescript
// addition to composeMenu's existing input
interface BucketEngagement {
  bucketKey: string;             // "${kind}:${is_unlabeled}"
  engagementRate: number;        // [0, 1], after §5 guardrails
  impressionCount: number;       // for §5.2 new-bucket cap inspection
  windowDays: 7 | 14 | 30;       // for audit / debugging
}

interface ComposeMenuInput {
  // ... existing fields (postExclusionCount, bucketAggregates, candidates,
  //                    cutoff, defaultNMultiplier)
  bucketEngagement?: BucketEngagement[];   // NEW; undefined = γ effectively 0
  engagementModelVersion?: string;          // NEW; undefined = legacy caller
}
```

`composeMenu` stays a **pure function**: aggregation happens upstream in the caller (the menu loader), `composeMenu` consumes the aggregate. Unit tests, the measurement harness, and any other in-process simulator pass synthetic `bucketEngagement` arrays without touching a DB.

When `bucketEngagement === undefined`:
- The `γ · engagement_signal(b)` term in §4 is **zero for every bucket**.
- Behavior is exactly RFC 0001-equivalent.
- This is the legacy / kill-switch / test-harness path.

When `bucketEngagement !== undefined`:
- Each entry sets the `engagement_signal(b)` for one bucket.
- Buckets present in `candidates` but absent from `bucketEngagement` get `engagement_signal(b) = 0` (cold-start §6, or new-bucket cap §5.2).
- §5.4's exploration-share pre-allocation runs.

### §9.2 Caller responsibilities

The menu loader (in `src/lib/triage/server-actions.ts` per #589's scope) is responsible for:

1. Executing the aggregate SQL (§7) for the active window and strictness stop.
2. Applying §5.2's new-bucket cap and §6's tenant cold-start gate (these are post-aggregation filters, not formula changes — they zero out an entry in `bucketEngagement` rather than removing it).
3. Resolving the current `engagement_model_version` from the tunables module.
4. Writing the impression batch — including `engagement_model_version` and `slot_bucket` — to `engagement_impression` after `composeMenu` returns.

The kill-switch is the menu loader passing `bucketEngagement: undefined` (or omitting it). When the tunables module's `γ === 0`, the loader **should** still pass an aggregate (so the version is recorded for audit), but `composeMenu` will multiply by zero and produce RFC 0001-equivalent output.

### §9.3 Tunables module

A new module `src/lib/triage/baseline/engagement-tunables.ts` parallel to [`tunables.ts`](../src/lib/triage/baseline/tunables.ts):

```typescript
export const ENGAGEMENT_TUNABLES = {
  gamma: 0,                                    // §4
  perBucketMinImpressions: 100,                // §5.2 N_min
  ewmaHalfLifeWindowRatio: 0.5,                // §5.3 (half-life = W * ratio)
  explorationShare: 0.1,                       // §5.4 ε
  tenantColdStartMinImpressions: 1000,         // §6 M_tenant
  includedShownBy: ['quota'] as const,         // §2.3
  engagedActions: ['pivot_click'] as const,    // §2.1 + §10.1
  actionSessionWindowHours: 24,                // §2.2
  activeWindowsDays: [7, 14, 30] as const,     // §3
  engagementModelVersion: 'phase2-v1',         // §8.1
};
```

A drift test (mirroring [the existing `tunables.ts` drift test pattern](../src/lib/triage/baseline/compose.mjs#L50)) asserts that every key in `ENGAGEMENT_TUNABLES` matches the active `engagement_model_snapshot` row for the current `engagementModelVersion`.

---

## §10. Open questions resolved

### §10.1 `story_pivot_click` attribution

**Recommendation: count `story_pivot_click` equally with `pivot_click` for v1.**

The three interpretations:

| Interpretation | Effect on slot share |
|----------------|----------------------|
| (a) Counts as engagement with origin event's bucket | Origin bucket's engagement rate ↑ |
| (b) Signals the origin bucket was *less* useful than Story | Origin bucket's engagement rate ↓ (would require recording as a negative signal) |
| (c) Excluded from slot-share signal entirely; impression-only | Origin bucket's engagement rate unchanged from `pivot_click`-only baseline |

(b) introduces a "negative engagement" semantics that #588's schema does not represent — there is no signed engagement column and no convention for negative signals. Adding it would require expand work in #588 plus a calibration story for how negative signals interact with the EWMA decay and the new-bucket cap. Too much surface area for a v1.

(c) is honest but discards a useful signal: an analyst going to Story from an origin event *did* engage with the origin event (they chose to drill in, even if the drill led them to a different surface). Recording it as zero engagement understates engagement for buckets where Story drill-down is common.

(a) treats `story_pivot_click` as confirmation that the origin event was worth opening — symmetric with `pivot_click`'s treatment, with the difference being only the destination surface. This is the most defensible reading.

The cost of being wrong: if (a) is the wrong choice, buckets that are routine Story-drill-down origins (likely `unlabeled-HttpThreat` and other compositionally-meaningful kinds) will be slightly over-engaged. Calibration will reveal this in the observed engagement-rate distribution, and the retune can flip to (c). Schema cost of flipping (a) ↔ (c) is zero (just a tunable change); schema cost of flipping either to (b) is high. Choose the lower-regret direction.

**Decision: (a) — count `story_pivot_click` equally with `pivot_click` for v1.** Substrate evidence (§12) shows `unlabeled-HttpThreat` — the likely Story-drill-down origin — is already the largest bucket, so the over-engagement risk if (a) is wrong is bounded. Calibration (§11) reveals this in the observed distribution; the retune can flip to (c) by setting `engagedActions: ['pivot_click']` in `ENGAGEMENT_TUNABLES`. Flipping to (b) is not on the table for v1.

### §10.2 Recursive engagement bias across windows

**Recommendation: EWMA decay (§5.3) + fixed exploration share (§5.4), no IPS.**

The failure mode: bucket `b` is surfaced more in window `W` because its engagement was high in window `W-1`, which inflates its `W` denominator, which dampens its `W → W+1` rate naturally — but only when impressions accumulate roughly proportionally to engagement, which is not guaranteed.

Three candidate mitigations:

| Mitigation | What it does | Cost |
|------------|--------------|------|
| EWMA decay | Recent impressions weigh more — past dominance fades | Already in §5.3; zero extra cost |
| Fixed exploration share | Reserves slots for low-engagement buckets — they always get a chance to update the denominator | Already in §5.4; zero extra cost |
| Inverse propensity score (IPS) reweighting | Each impression weighted by `1 / P(surfaced)` so over-surfaced buckets are downweighted in the denominator | Requires recording the per-row surfacing probability — new instrumentation, complex calibration |

EWMA decay + exploration share **together** address the dominant failure mode without introducing IPS complexity. The empirical question — does this combination converge to a stable, sane distribution? — is what the calibration retune answers. If observation shows degenerate convergence (one bucket monopolizing the menu for weeks), IPS is the natural next escalation; Phase 3 (#590) is the right venue.

**Decision: EWMA decay (§5.3) + fixed exploration share (§5.4) for v1.** IPS is held in reserve for v2 if calibration (§11) reveals degenerate convergence; the additional instrumentation (per-row surfacing probability capture) is not on the table for v1.

---

## §11. Calibration protocol

The structural RFC is shippable today; the **numeric parameter values** above are placeholders calibrated against test-clumit's substrate (§12). The calibration retune (a `baseline_version` bump amendment) is gated on observation of real engagement data and runs against these criteria:

### Entry criteria

- **Production tenant with human-analyst traffic**, capturing engagement for ≥ **14 days** since #588 went live. (test-clumit's AI-agent traffic does **not** count — agent behavior is not a sample of analyst preference.)
- **≥ 2 tenants** contributing data, each with ≥ 14 days of capture. A single tenant's preference is not a defensible generalization for the per-bucket weights `γ` and `N_min` will encode.
- Per-bucket impression count ≥ **100** for the buckets included in retune; buckets below this threshold stay on cold-start defaults from §6 / §5.2 and are not used to fit `γ`.

### Excluded from retune

- Buckets with `impression_count < 100` over the calibration window (cold-start).
- Tenants in cold-start (`total_impression_count < M_tenant`) at any point during the calibration window.
- `shown_by ∈ {fallback, story_protected}` impressions (already excluded by §2.3, repeated here for clarity).
- The first 24 hours of capture per tenant (warm-up of the menu loader, possibly half-initialized).

### Artifacts produced

The calibration retune commits to producing the following analyses, posted as a comment on the Phase 2 follow-up issue:

1. **Per-bucket engagement-rate distribution** — histogram of `engagement_rate(b, W)` across all (bucket, tenant, window) tuples. Shape (heavy-tailed? bimodal?) drives `γ` magnitude.
2. **Exposure imbalance across strictness stops** — for each bucket, the engagement-rate divergence between `top5` and `top80`. Drives the §2.3 segment-vs-pool decision retest.
3. **Fallback-share by tenant** — fraction of impressions with `shown_by = 'fallback'`. If routinely > 20%, the §2.3 inclusion decision warrants revisit (the fallback path is doing too much work).
4. **New-bucket vs mature-bucket engagement-rate distribution** — separately histogram buckets below and above `N_min`. Drives the retune of `N_min`.
5. **Cold-start tenant duration** — distribution of (per-tenant) time from first impression to first cross-bucket variation in engagement. Drives `M_tenant` retune.
6. **EWMA half-life sensitivity** — recompute the aggregate at half-lives `W/4`, `W/2` (default), and `W/1`; report which produces the most stable bucket ordering across consecutive 24h windows. Drives the §5.3 ratio retune.

### Output

A `baseline_version` bump amendment to this RFC (RFC 0003a or similar) replacing the §12 placeholders with the observed values, plus the rationale paragraph for each retune drawn from the artifacts above.

---

## §12. Initial substrate-informed defaults

All values below ship with #589's first commit. They are **conservative starting points**, not calibrated values. The calibration retune (§11) replaces them.

| Parameter                            | Initial value     | Source / rationale                                            |
|--------------------------------------|-------------------|---------------------------------------------------------------|
| `γ` (engagement weight)              | **0**             | Kill-switch off. Behavior is RFC 0001-equivalent.             |
| `N_min` (per-bucket impression floor) | **100**          | test-clumit lowest-volume bucket reachable in 1–7 days.       |
| EWMA half-life ratio                  | **0.5** of window | W/2 keeps effective sample size near half the window.        |
| `ε` (exploration share)               | **0.1**           | ~1 slot per 10 in default_N for low-engagement buckets.       |
| `M_tenant` (tenant cold-start floor) | **1,000 impressions** | Any first-week active tenant clears this.                   |
| `INCLUDED_SHOWN_BY`                   | `{'quota'}`       | Most conservative — excludes fallback / story_protected.      |
| `ENGAGED_ACTIONS`                     | `{pivot_click, story_pivot_click}` | §2.1 + §10.1 recommendation.                |
| `action_session_window_hours`         | **24**            | An action a day after the impression is not credibly causal.  |
| Active windows                        | **7d / 14d / 30d** | Reused from RFC 0001 §7.                                     |
| Active window selection               | longest-active-with-data | §3.                                                    |
| `engagement_model_version`            | **`'phase2-v1'`** | §8.1.                                                         |

### Substrate snapshot (for traceability)

Captured 2026-05-16 from `customer_customer_a_8983d4` on test-clumit:

| Metric                              | Value     |
|-------------------------------------|-----------|
| `baseline_triaged_event` row count  | 200,000   |
| `observed_event_meta` row count     | 1,000,000 |
| Time span                           | 30 days (2026-04-13 → 2026-05-13) |
| Distinct slot buckets               | 11        |
| Bucket volume skew (max/min)        | ~5.5× (largest `HttpThreat:true` 34,147 vs smallest `SuspiciousTlsTraffic:false` 6,174) |
| Favored buckets present             | 5 of 5 (`unlabeled-HttpThreat` is the **largest** bucket at 17.07%) |
| `baseline_version` values present   | `phase1a-simple`, `phase1b-four-selector` |

Per-bucket counts (descending):

| Slot bucket                              | Rows   | Share  | Favored? |
|------------------------------------------|--------|--------|----------|
| `HttpThreat:true` (unlabeled-HttpThreat) | 34,147 | 17.07% | yes      |
| `DnsCovertChannel:false`                 | 29,908 | 14.95% | yes      |
| `HttpThreat:false` (labeled)             | 26,024 | 13.01% | no       |
| `LdapPlainText:false`                    | 20,160 | 10.08% | no       |
| `LockyRansomware:false`                  | 19,806 |  9.90% | yes      |
| `DomainGenerationAlgorithm:false`        | 15,993 |  8.00% | no       |
| `FtpPlainText:false`                     | 15,871 |  7.94% | no       |
| `TorConnection:false`                    | 13,965 |  6.98% | no       |
| `NonBrowser:false`                       |  9,967 |  4.98% | no       |
| `RepeatedHttpSessions:false`             |  7,985 |  3.99% | yes      |
| `SuspiciousTlsTraffic:false`             |  6,174 |  3.09% | yes      |

The dominance of `unlabeled-HttpThreat` (favored bucket, largest by volume) reflects the production expectation that cluster classifier coverage is incomplete and unlabeled HttpThreat events accumulate. This validates §4's orthogonality decision: with `γ = 0` the `unlabeled-HttpThreat` bucket already wins share through `favored_bonus + α · volume · confidence`; the engagement term adds to that share for buckets analysts actually click, without stripping the prior from buckets that go quiet.

Substrate-informed observations that shaped the defaults:
- **Smallest bucket is 6,174 rows / 30d ≈ 200/day.** `N_min = 100` (§5.2) is reachable within ~12 hours of impression flow for every bucket, so the new-bucket cap does not strand any kind permanently.
- **Volume skew is ~5.5×, not extreme.** `α · normalized_volume · normalized_top_confidence` (RFC 0001 §5.1) keeps the top bucket from dominating; engagement term layered on top does not amplify the skew.
- **3 favored buckets (`LockyRansomware`, `RepeatedHttpSessions`, `SuspiciousTlsTraffic`) sit in the low-volume tail.** They already rely on `favored_bonus` to stay visible — engagement is the variance the term encodes, not the level.

---

## §13. Rollout

### Phase 2a — first ship (gated only on #588 merge)

1. #588 (PR #606) merges. `engagement_impression` and `engagement_action` exist in tenant DBs.
2. #589 implements:
   - `ENGAGEMENT_TUNABLES` per §9.3 with §12's initial values.
   - Aggregate SQL per §7.
   - `composeMenu` per §9.1, with `bucketEngagement` plumbed from the menu loader.
   - `engagement_model_snapshot` migration per §8.2.
   - `engagement_impression.engagement_model_version` expand migration per §8.3.
   - Drift test for `ENGAGEMENT_TUNABLES` vs the snapshot.
3. `baseline_version` bump (e.g. `phase1b-four-selector` → `phase2-engagement-v1`).
4. Ship. With `γ = 0` the per-bucket quotas are numerically identical to RFC 0001's output, modulo the exploration share's floor (§5.4 still applies at `ε = 0.1`).

### Phase 2b — calibration retune (gated on §11 entry criteria)

5. #588 has run in production for ≥ 14 days across ≥ 2 tenants. Observation artifacts (§11) produced.
6. RFC 0003a amendment replaces §12's placeholders with calibrated values, primarily `γ`.
7. New `engagement_model_version` (e.g. `phase2-engagement-v2`) shipped with `baseline_version` bump.

### Phase 3 (separate RFC, #590)

Within-kind ranking and per-selector weight feedback. Outside this RFC's scope; only mentioned here to note that Phase 3 may revisit §2.3's denominator choice, §5's guardrails, and §10.2's mitigation strategy if Phase 2 data reveals limitations.

---

## Out of scope

- **Within-kind ranking** — owned by RFC for #590 / #594. This RFC fixes per-bucket *quotas*; within-bucket order remains RFC 0001 §6's tiebreaker.
- **Per-selector weight feedback** — same owner.
- **Explicit feedback UI** (per-event 👍 / 👎, kind-level hide/promote) — re-evaluated after Phase 2 data shows whether implicit signals suffice.
- **Cross-tenant engagement aggregation** — engagement is per-tenant (§3). Global priors are out of scope; if useful, they enter via a separate epic.
- **Corpus B (`policy_triage_run`) engagement** — the engagement model is scoped to Corpus A (baseline). The Corpus B mode is currently UI-disabled ([mode-toggle.tsx:50](../src/components/triage/mode-toggle.tsx#L50)); when #597 activates it, a follow-up RFC extends or replicates this design for Corpus B.

## Discussion

See [#593](https://github.com/aicers/aice-web-next/issues/593) for the RFC requirements that produced this design, and [#588](https://github.com/aicers/aice-web-next/issues/588) (PR [#606](https://github.com/aicers/aice-web-next/pull/606)) for the capture schema this RFC consumes.
