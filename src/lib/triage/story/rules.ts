/**
 * Story v1 heuristic rule set (Story RFC §3, §7, §8).
 *
 * Pure predicate functions over an in-memory candidate event set. No
 * database access — the correlator (`./correlator.ts`) reads the
 * candidate set from `baseline_triaged_event` and threads it through
 * these rules before writing the resulting drafts via
 * `./repository.ts`.
 *
 * Four conservative rules ship under `story_version = 'v1'`:
 *
 *   - R1 — same `primary_asset` (orig_addr), within a 10-minute window,
 *     has events from ≥2 distinct categories in the critical-category
 *     set.
 *   - R3 — same `primary_asset` has ≥3 events whose `selector_tags`
 *     overlap the critical-selector set within a 1-hour window.
 *   - R4 — fan-in: ≥`R4_MIN_SOURCES` distinct `orig_addr` converge on
 *     one victim (`resp_addr`) with the same critical `category`,
 *     within a 1-hour window.
 *   - R5 — campaign: the same critical `category` is driven by
 *     ≥`R5_MIN_SOURCES` distinct `orig_addr` against
 *     ≥`R5_MIN_VICTIMS` distinct `resp_addr`, within a 1-hour window.
 *
 * R2 — multi-stage low-and-slow ("slow R1", #702): the same
 * `orig_addr`, within the 24h low-and-slow window, touches ≥3 distinct
 * `category` values in ANY order (revisits allowed), dispersed across
 * ≥3 UTC hour buckets, with ≥1 category in the critical set. It keys on
 * `category` (like R1) — order-agnostic by design, since real attackers
 * oscillate across kill-chain stages. Produced only by the hourly
 * low-and-slow sweep, alongside R6.
 *
 * R4/R5 share R1's category predicate and R3's selector predicate as
 * the conservative "same-attack" identity: an event is eligible only
 * when its `category ∈ CRITICAL_CATEGORIES` AND its `selector_tags`
 * overlap `CRITICAL_SELECTOR_SET`. Both additionally exclude
 * `orig_addr IS NULL` and `resp_addr IS NULL` (R4 keys on the victim;
 * R5's distinct-victim floor cannot attribute a null-victim event).
 *
 * Both rules predicate on `selector_tags` membership and on the row's
 * own `category` column — never on `baseline_score` (read-time only,
 * does not exist on the row at cadence time) and never on `raw_score`
 * (absolute scale shifts across `baseline_version` bumps). The
 * critical-category and critical-selector lists are explicit so an
 * RFC 0001 §9 rename or addition is caught at Story RFC review time.
 */

import type { ThreatCategory } from "@/lib/detection";
import { CRITICAL_CATEGORIES } from "@/lib/triage/baseline/categories";
import {
  CRITICAL_SELECTOR_SET as CRITICAL_SELECTOR_SET_RAW,
  LOWSLOW_SELECTOR_SET as LOWSLOW_SELECTOR_SET_RAW,
  R4_MIN_SOURCES as R4_MIN_SOURCES_RAW,
  R5_MIN_SOURCES as R5_MIN_SOURCES_RAW,
  R5_MIN_VICTIMS as R5_MIN_VICTIMS_RAW,
} from "@/lib/triage/story/critical-sets.mjs";
import { ACTIVE_RULE_IDS, type StoryRuleId } from "@/lib/triage/story/types";

/**
 * Story RFC version stamp. Mirrors `baseline_version` and follows the
 * same natural-expiry model: bumping this produces new `event_group`
 * rows tagged with the new value; old rows age out via retention
 * without retroactive recomputation.
 */
export const STORY_VERSION = "v1";

/**
 * Hard cap on the number of `primary` members per auto-correlated
 * Story (Story RFC §8). Matches the cap analyst-curated Stories will
 * enforce in #490 so the LLM context budget stays uniform across
 * creation paths.
 */
export const STORY_MEMBER_CAP = 50;

/**
 * R1 window — 10 minutes.
 */
export const R1_WINDOW_MS = 10 * 60 * 1000;

/**
 * R3 window — 1 hour.
 */
export const R3_WINDOW_MS = 60 * 60 * 1000;

/**
 * Shared multi-source window for R4 (fan-in) and R5 (campaign) — 1
 * hour. Kept equal to R3's window so `MAX_RULE_WINDOW_MS` (and the
 * §4 slop-replay lookback) stays at 1 hour; widening it would force a
 * Story RFC bump.
 */
export const MULTI_SOURCE_WINDOW_MS = 60 * 60 * 1000;

/**
 * R4 (fan-in) threshold — minimum distinct source IPs (`orig_addr`)
 * converging on one victim (`resp_addr`) with the same critical
 * `category` inside the window. Calibration knob.
 *
 * Re-exported from `./critical-sets.mjs` so the rule layer and the
 * measurement harness (`.mjs`, plain Node) read one source of truth.
 */
export const R4_MIN_SOURCES = R4_MIN_SOURCES_RAW;

/**
 * R5 (campaign) source threshold — minimum distinct source IPs
 * (`orig_addr`) driving the same critical `category` inside the
 * window. Calibration knob.
 */
export const R5_MIN_SOURCES = R5_MIN_SOURCES_RAW;

/**
 * R5 (campaign) victim threshold — minimum distinct victims
 * (`resp_addr`) the campaign must span. The `≥ 2 victims` floor is
 * what distinguishes a campaign from an R4 fan-in (one converging
 * victim).
 */
export const R5_MIN_VICTIMS = R5_MIN_VICTIMS_RAW;

/**
 * Maximum rule window. The slop-replay protocol uses this as the
 * member-scan lookback so an R3/R4/R5 cluster whose `time_window_end`
 * falls just past the previous watermark can still pick up members
 * that sit before the watermark but inside the rule window. All of
 * R3, R4, and R5 use a 1-hour window, so this stays at 1 hour.
 */
export const MAX_RULE_WINDOW_MS = Math.max(
  R1_WINDOW_MS,
  R3_WINDOW_MS,
  MULTI_SOURCE_WINDOW_MS,
);

/**
 * Slop-window length applied at finalization (Story RFC §3 / §4). A
 * cluster whose `time_window_end` is within the last `SLOP_WINDOW_MS`
 * of the page's `event_time` range is deferred to a subsequent tick.
 */
export const SLOP_WINDOW_MS = 30 * 60 * 1000;

/**
 * R6 (persistent low-and-slow) sliding window — 24 hours (issue
 * #701). Deliberately decoupled from `MAX_RULE_WINDOW_MS`: R6 runs
 * only from the hourly low-and-slow sweep
 * (`baseline/lowslow-sweep.ts`), never from per-page step (f), so its
 * 24h window does NOT widen `MAX_RULE_WINDOW_MS` and does not force
 * every page commit to rescan 24h of events.
 */
export const LOWSLOW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * R6 dispersion floor — minimum distinct UTC hour buckets
 * (`date_trunc('hour', event_time AT TIME ZONE 'UTC')`) a cluster must
 * span. `≥ 3` buckets is what excludes a burst (a ≤1h R3 cluster
 * straddles at most two hour boundaries), giving R6 no overlap with
 * R3. This literal mirrors the phase-1 SQL's
 * `COUNT(DISTINCT date_trunc('hour', …)) >= 3` in
 * `./read-path-sql.mjs`; the two must stay in sync.
 */
export const LOWSLOW_MIN_BUCKETS = 3;

/**
 * R6 member floor — minimum events on one asset overlapping the R6
 * selector set inside the 24h window. Mirrors the phase-1 SQL's
 * `COUNT(*) >= 3` (`./read-path-sql.mjs`); the two must stay in sync.
 */
export const R6_MIN_MEMBERS = 3;

/**
 * R2 distinct-category floor (issue #702) — minimum distinct
 * `category` values one asset must touch, in any order, inside the 24h
 * low-and-slow window for R2 (multi-stage low-and-slow) to fire.
 * Mirrors the phase-1 SQL's `COUNT(DISTINCT category) >= 3`
 * (`./read-path-sql.mjs`); the two must stay in sync. R2 reuses the
 * shared `LOWSLOW_WINDOW_MS` window and `LOWSLOW_MIN_BUCKETS`
 * dispersion floor.
 */
export const R2_MIN_CATEGORIES = 3;

/**
 * R6 selector set (issue #701). Extends R3's `CRITICAL_SELECTOR_SET`
 * with `S3-recurring` — recurrence is the defining beacon signature.
 *
 * Re-exported from `./critical-sets.mjs` so the rule layer, the R6
 * push-down SQL, and the measurement harness all read one Node-safe
 * source of truth (the R6 selector set is NOT a `rules.ts` tunable —
 * see the module's header rationale for `CRITICAL_SELECTOR_SET`).
 */
export const LOWSLOW_SELECTOR_SET = LOWSLOW_SELECTOR_SET_RAW;

/**
 * λ coefficient for R1's score (Story RFC §3.R1). The R1 score is
 * `member_count + R1_LAMBDA * distinct_category_count`, a Story-side
 * count that is NOT a function of `raw_score`.
 */
export const R1_LAMBDA = 1.0;

/**
 * Critical-selector set consumed by R3 (Story RFC §3.R3). The v1
 * starting set is the two §9 tags whose semantics map to
 * "critical-class" rather than "frequency/correlation pattern". A
 * future RFC 0001 selector rename or addition triggers a Story RFC
 * review.
 *
 * Re-exported from `./critical-sets.mjs` so the cadence layer, the
 * rule layer, and the measurement harness `.mjs` all read the same
 * source of truth (issue #601).
 */
export const CRITICAL_SELECTOR_SET = CRITICAL_SELECTOR_SET_RAW;

/**
 * Active rule IDs the correlator emits. R2 (multi-stage low-and-slow,
 * #702) is the order-agnostic "slow R1": pulled forward into v1 with
 * redefined semantics (no kill-chain ordering), produced only by the
 * hourly sweep. R4/R5 are the multi-source rules (#694); R6 is the
 * persistent low-and-slow rule (#701), also sweep-only.
 *
 * `ACTIVE_RULE_IDS` and `StoryRuleId` are defined canonically in
 * `./types.ts` and re-exported here so existing importers of this
 * module keep resolving against the single source of truth (#711).
 */
export { ACTIVE_RULE_IDS, type StoryRuleId };

/**
 * Slim candidate-event shape the rules operate on. Carries only the
 * columns the predicates and the summary payload need — the broader
 * `TriageEvent` shape stays in the pager layer.
 */
export interface CandidateEvent {
  eventKey: string;
  eventTime: Date;
  kind: string;
  origAddr: string | null;
  /**
   * The destination/victim address, normalized via `host()` like
   * `origAddr`. Read by R4/R5 (which key on the victim); `null` for
   * R1/R3 candidate reads that do not select it. `null` is also the
   * value for events whose `resp_addr` is genuinely absent.
   */
  respAddr: string | null;
  category: ThreatCategory | string | null;
  selectorTags: readonly string[];
  rawScore: number;
}

/**
 * Required fixed-key set on `event_group.summary_payload` (Story
 * RFC §7). Adding a key is RFC-only; removing or renaming a key is a
 * `story_version` bump.
 */
export interface StorySummaryPayload {
  kindHistogram: Record<string, number>;
  categoryHistogram: Record<string, number>;
  memberCount: number;
  durationMs: number;
  distinctAssetCount: number;
  /**
   * Story-internal sort hint kept as the max `raw_score` over the
   * Story's members. NOT surfaced to UI as a baseline percentile —
   * `raw_score`'s absolute scale shifts across `baseline_version`
   * bumps, so a numeric comparison across Stories is only valid
   * within the same `story_version` cohort.
   */
  topRawScore: number;
}

/**
 * Draft Story emitted by a rule. The correlator threads this through
 * the finalization filter (slop window) and `./repository.ts` to
 * produce an `event_group` row plus member rows.
 */
export interface StoryDraft {
  ruleId: StoryRuleId;
  /**
   * Asset the Story keys on. `orig_addr` for R1/R3, `resp_addr` (the
   * victim) for R4, and `null` for R5 (a campaign has no single
   * converging asset). Persisted to `event_group.primary_asset`.
   */
  primaryAsset: string | null;
  /**
   * Dedup discriminator persisted to `event_group.correlation_key`.
   * `null` for R1/R3 (which dedup on `primary_asset` via the legacy
   * partial unique index). R4 sets `host(resp_addr) || '|' ||
   * category`; R5 sets `category`. When non-null, the row is
   * governed by the `event_group_corrkey_dedup_idx` index instead of
   * the asset index (see `repository.ts` `insertAutoStory`).
   */
  correlationKey?: string | null;
  /**
   * Cluster span `time_window_start = min(member.event_time)`,
   * `time_window_end = max(member.event_time)`. Stored on the
   * `event_group` row; the finalization filter compares
   * `time_window_end` against the slop horizon.
   */
  timeWindowStart: Date;
  timeWindowEnd: Date;
  /**
   * Member list capped at {@link STORY_MEMBER_CAP}. Ordering is
   * deterministic (see {@link applyMemberCap}) so re-evaluation of
   * the same window produces the same member set under
   * `ON CONFLICT DO NOTHING`.
   */
  members: CandidateEvent[];
  score: number;
  summary: StorySummaryPayload;
}

/**
 * Determine the candidate-events subset that contains a non-NULL
 * `orig_addr`. R1 and R3 are both asset-keyed; the partial unique
 * index on `event_group` also requires a non-NULL `primary_asset`,
 * so a NULL-asset cluster cannot be deduped and is unreachable in
 * v1 by construction.
 */
function withAsset(events: ReadonlyArray<CandidateEvent>): CandidateEvent[] {
  return events.filter((e) => e.origAddr !== null);
}

/**
 * Group candidates by their `orig_addr`. Returns a map from asset
 * string to the asset's sorted (ascending `event_time`) event list.
 * Ties on `event_time` are broken by `event_key` so the cluster
 * boundaries are deterministic across re-evaluations.
 */
function groupByAsset(
  events: ReadonlyArray<CandidateEvent>,
): Map<string, CandidateEvent[]> {
  const map = new Map<string, CandidateEvent[]>();
  for (const e of withAsset(events)) {
    const key = e.origAddr as string;
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(e);
    } else {
      map.set(key, [e]);
    }
  }
  for (const bucket of map.values()) {
    bucket.sort(
      (a, b) =>
        a.eventTime.getTime() - b.eventTime.getTime() ||
        a.eventKey.localeCompare(b.eventKey),
    );
  }
  return map;
}

/**
 * True sliding-window clustering. For each event in ascending-time
 * order, compute the maximal contiguous suffix `[i, j]` such that
 * `events[j].time − events[i].time ≤ windowMs`. A cluster is emitted
 * only when it is **left-maximal** — i.e., extending the cluster
 * leftward by one event would break the window. This finds every
 * maximal valid window, including overlapping ones, instead of the
 * greedy "reset whenever the current window breaks" partition that
 * misses windows starting inside a prior bucket.
 *
 * Example (windowMs = 1 h): events at 00:00, 00:59, 01:01, 01:02.
 *   - i=0 → [00:00, 00:59] (extending to 01:01 breaks: 61 min).
 *     Left-maximal. Size 2.
 *   - i=1 → [00:59, 01:01, 01:02] (window 3 min ≤ 1 h). Left-
 *     maximal because adding events[0] would make the span
 *     01:02 − 00:00 = 62 min > 60. Size 3.
 *   - i=2, i=3 → contained in the i=1 cluster. Not left-maximal.
 * The greedy partition misses the i=1 cluster entirely.
 *
 * Idempotency: the algorithm is deterministic given a sorted input,
 * so a re-scan of the same candidate set produces identical
 * clusters, and the partial unique index on
 * `(rule, asset, window_start, window_end)` dedups across ticks.
 */
function clusterByWindow(
  events: ReadonlyArray<CandidateEvent>,
  windowMs: number,
): CandidateEvent[][] {
  const n = events.length;
  if (n === 0) return [];
  const clusters: CandidateEvent[][] = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (j < i) j = i;
    while (
      j + 1 < n &&
      events[j + 1].eventTime.getTime() - events[i].eventTime.getTime() <=
        windowMs
    ) {
      j += 1;
    }
    // Left-maximal: either at the start, or extending one step left
    // would make the span exceed windowMs at `events[j]`.
    const leftMaximal =
      i === 0 ||
      events[j].eventTime.getTime() - events[i - 1].eventTime.getTime() >
        windowMs;
    if (!leftMaximal) continue;
    clusters.push(events.slice(i, j + 1));
  }
  return clusters;
}

/**
 * Sampling order from Story RFC §8: `cardinality(selector_tags) DESC`,
 * ties broken by `event_time DESC`, with `event_key` as a final
 * total-order tiebreaker so two events whose times collide produce a
 * deterministic order across re-evaluations. The order is a
 * deterministic-sampling key, NOT a ranking — `raw_score` is
 * intentionally not used because Story members can span multiple
 * `kind` / `baseline_version` cohorts where its absolute scale is
 * not comparable.
 */
export function applyMemberCap(
  members: ReadonlyArray<CandidateEvent>,
  cap: number = STORY_MEMBER_CAP,
): CandidateEvent[] {
  if (members.length <= cap) return [...members];
  const sorted = [...members].sort((a, b) => {
    const ca = a.selectorTags.length;
    const cb = b.selectorTags.length;
    if (ca !== cb) return cb - ca;
    const tb = b.eventTime.getTime() - a.eventTime.getTime();
    if (tb !== 0) return tb;
    return a.eventKey.localeCompare(b.eventKey);
  });
  return sorted.slice(0, cap);
}

/**
 * Compute the fixed-key `summary_payload` for a Story's member set.
 * Independent of any cadence-side `payload_summary` extension; the
 * shape is fixed by Story RFC §7 so #490 binds to a stable contract
 * across rule versions.
 */
export function buildSummaryPayload(
  members: ReadonlyArray<CandidateEvent>,
): StorySummaryPayload {
  const kindHistogram: Record<string, number> = {};
  const categoryHistogram: Record<string, number> = {};
  const assets = new Set<string>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  let topRawScore = 0;
  for (const m of members) {
    kindHistogram[m.kind] = (kindHistogram[m.kind] ?? 0) + 1;
    if (m.category !== null) {
      const key = String(m.category);
      categoryHistogram[key] = (categoryHistogram[key] ?? 0) + 1;
    }
    if (m.origAddr !== null) assets.add(m.origAddr);
    const t = m.eventTime.getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
    if (m.rawScore > topRawScore) topRawScore = m.rawScore;
  }
  const durationMs =
    minTime === Number.POSITIVE_INFINITY ? 0 : maxTime - minTime;
  return {
    kindHistogram,
    categoryHistogram,
    memberCount: members.length,
    durationMs,
    distinctAssetCount: assets.size,
    topRawScore,
  };
}

/**
 * R1 — same `primary_asset`, 10-minute window, ≥2 distinct
 * critical categories.
 */
export function detectR1(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const byAsset = groupByAsset(
    events.filter(
      (e) =>
        e.category !== null &&
        CRITICAL_CATEGORIES.has(e.category as ThreatCategory),
    ),
  );
  for (const [asset, perAsset] of byAsset) {
    const clusters = clusterByWindow(perAsset, R1_WINDOW_MS);
    for (const cluster of clusters) {
      const distinctCategories = new Set(
        cluster.map((m) => String(m.category)),
      );
      if (distinctCategories.size < 2) continue;
      const capped = applyMemberCap(cluster);
      // Cluster span is computed BEFORE the cap so the window is the
      // semantic match window, not the post-sampling subset's span.
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      const score = capped.length + R1_LAMBDA * distinctCategories.size;
      drafts.push({
        ruleId: "R1",
        primaryAsset: asset,
        correlationKey: null,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * R3 — same `primary_asset`, 1-hour window, ≥3 events whose
 * `selector_tags` overlap the critical-selector set.
 */
export function detectR3(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const byAsset = groupByAsset(
    events.filter((e) =>
      e.selectorTags.some((t) => CRITICAL_SELECTOR_SET.has(t)),
    ),
  );
  for (const [asset, perAsset] of byAsset) {
    const clusters = clusterByWindow(perAsset, R3_WINDOW_MS);
    for (const cluster of clusters) {
      if (cluster.length < 3) continue;
      const capped = applyMemberCap(cluster);
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      drafts.push({
        ruleId: "R3",
        primaryAsset: asset,
        correlationKey: null,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score: capped.length,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * Shared "same-attack" eligibility predicate for the multi-source
 * rules R4/R5: critical `category`, critical-selector overlap, and a
 * non-NULL source AND victim. R4 keys on the victim and R5's
 * distinct-victim floor cannot attribute a null-victim event, so a
 * member with no `resp_addr` contributes to neither rule's victim
 * accounting and is dropped from candidacy entirely.
 */
function isMultiSourceEligible(e: CandidateEvent): boolean {
  return (
    e.origAddr !== null &&
    e.respAddr !== null &&
    e.category !== null &&
    CRITICAL_CATEGORIES.has(e.category as ThreatCategory) &&
    e.selectorTags.some((t) => CRITICAL_SELECTOR_SET.has(t))
  );
}

/**
 * Group eligible events into buckets by a caller-supplied key,
 * returning each bucket sorted by ascending `event_time` (ties broken
 * by `event_key`) so `clusterByWindow` sees a deterministic order.
 */
function groupBy(
  events: ReadonlyArray<CandidateEvent>,
  keyOf: (e: CandidateEvent) => string,
): Map<string, CandidateEvent[]> {
  const map = new Map<string, CandidateEvent[]>();
  for (const e of events) {
    const key = keyOf(e);
    const bucket = map.get(key);
    if (bucket) bucket.push(e);
    else map.set(key, [e]);
  }
  for (const bucket of map.values()) {
    bucket.sort(
      (a, b) =>
        a.eventTime.getTime() - b.eventTime.getTime() ||
        a.eventKey.localeCompare(b.eventKey),
    );
  }
  return map;
}

/**
 * R4 — Fan-in. Within a 1-hour window, ≥`R4_MIN_SOURCES` distinct
 * `orig_addr` target the same `resp_addr` with the same critical
 * `category`, all members satisfying the critical-selector predicate.
 *
 *   - Grouping key: `(resp_addr, category)`.
 *   - `primary_asset = resp_addr` (the victim).
 *   - `correlation_key = host(resp_addr) || '|' || category`.
 *   - Score: distinct source-IP count in the window (pre-cap).
 */
export function detectR4(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const eligible = events.filter(isMultiSourceEligible);
  const byKey = groupBy(
    eligible,
    (e) => `${e.respAddr as string}|${String(e.category)}`,
  );
  for (const bucket of byKey.values()) {
    const clusters = clusterByWindow(bucket, MULTI_SOURCE_WINDOW_MS);
    for (const cluster of clusters) {
      const distinctSources = new Set(cluster.map((m) => m.origAddr));
      if (distinctSources.size < R4_MIN_SOURCES) continue;
      const respAddr = cluster[0].respAddr as string;
      const category = String(cluster[0].category);
      const capped = applyMemberCap(cluster);
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      drafts.push({
        ruleId: "R4",
        primaryAsset: respAddr,
        correlationKey: `${respAddr}|${category}`,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score: distinctSources.size,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * R5 — Campaign. Within a 1-hour window, the same critical
 * `category` is driven by ≥`R5_MIN_SOURCES` distinct `orig_addr`
 * against ≥`R5_MIN_VICTIMS` distinct `resp_addr`, all members
 * satisfying the critical-selector predicate.
 *
 *   - Grouping key: `category` (the shared signature).
 *   - `primary_asset = NULL` (no single converging asset).
 *   - `correlation_key = category`.
 *   - Score: distinct source-IP count in the window (pre-cap).
 */
export function detectR5(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const eligible = events.filter(isMultiSourceEligible);
  const byCategory = groupBy(eligible, (e) => String(e.category));
  for (const bucket of byCategory.values()) {
    const clusters = clusterByWindow(bucket, MULTI_SOURCE_WINDOW_MS);
    for (const cluster of clusters) {
      const distinctSources = new Set(cluster.map((m) => m.origAddr));
      const distinctVictims = new Set(cluster.map((m) => m.respAddr));
      if (distinctSources.size < R5_MIN_SOURCES) continue;
      if (distinctVictims.size < R5_MIN_VICTIMS) continue;
      const category = String(cluster[0].category);
      const capped = applyMemberCap(cluster);
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      drafts.push({
        ruleId: "R5",
        primaryAsset: null,
        correlationKey: category,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score: distinctSources.size,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * UTC-anchored hour-bucket identity for a candidate event. Floors the
 * epoch-ms timestamp to its UTC hour so the bucket never depends on
 * the DB / session / host timezone. Equivalent to the phase-1 SQL's
 * `date_trunc('hour', event_time AT TIME ZONE 'UTC')`: two timestamps
 * land in the same bucket iff they truncate to the same UTC hour, so a
 * row near a local-midnight boundary buckets identically on the JS and
 * SQL sides.
 */
function utcHourBucket(eventTime: Date): number {
  return Math.floor(eventTime.getTime() / (60 * 60 * 1000));
}

/**
 * R6 — Persistent low-and-slow ("slow R3"). Within a 24-hour sliding
 * window, the same `orig_addr` has ≥`R6_MIN_MEMBERS` events whose
 * `selector_tags` overlap the R6 selector set, dispersed across
 * ≥`LOWSLOW_MIN_BUCKETS` distinct UTC hour buckets.
 *
 *   - Grouping key / `primary_asset`: `orig_addr` (single-source).
 *   - `correlation_key = NULL` — R6 dedups on the re-scoped
 *     `event_group_auto_dedup_idx` via `insertAutoStory`'s
 *     NULL-`correlationKey` branch, exactly like R1/R3.
 *   - Score: member count (post-cap), like R3.
 *
 * The ≥3-bucket dispersion floor is what excludes a burst (a ≤1h R3
 * cluster straddles at most two hour boundaries), so R6 does not
 * overlap R3. Called ONLY from the low-and-slow sweep's correlation
 * function (`baseline/lowslow-sweep.ts`), never from `runStepF` — this
 * keeps `MAX_RULE_WINDOW_MS` at 1 hour. The JS hour bucketing is UTC
 * ({@link utcHourBucket}), matching the phase-1 SQL.
 */
export function detectR6(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const byAsset = groupByAsset(
    events.filter((e) =>
      e.selectorTags.some((t) => LOWSLOW_SELECTOR_SET.has(t)),
    ),
  );
  for (const [asset, perAsset] of byAsset) {
    const clusters = clusterByWindow(perAsset, LOWSLOW_WINDOW_MS);
    for (const cluster of clusters) {
      if (cluster.length < R6_MIN_MEMBERS) continue;
      // Dispersion is computed over the FULL cluster (pre-cap), so the
      // ≥3-bucket test reflects the semantic match window rather than
      // the sampled member subset.
      const buckets = new Set(cluster.map((m) => utcHourBucket(m.eventTime)));
      if (buckets.size < LOWSLOW_MIN_BUCKETS) continue;
      const capped = applyMemberCap(cluster);
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      drafts.push({
        ruleId: "R6",
        primaryAsset: asset,
        correlationKey: null,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score: capped.length,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * R2 — Multi-stage low-and-slow ("slow R1", order-agnostic, issue
 * #702). Within a 24-hour sliding window, the same `orig_addr` touches
 * ≥`R2_MIN_CATEGORIES` distinct `category` values — in ANY order,
 * revisits allowed — dispersed across ≥`LOWSLOW_MIN_BUCKETS` distinct
 * UTC hour buckets, with ≥1 category in `CRITICAL_CATEGORIES`.
 *
 *   - Grouping key / `primary_asset`: `orig_addr` (single-source).
 *   - `correlation_key = NULL` — like R1/R3/R6, R2 dedups on the
 *     `event_group_auto_dedup_idx` NULL-`correlationKey` branch.
 *   - Score: distinct-`category` count over the FULL cluster (pre-cap).
 *
 * Order-agnostic by design: the signal is breadth of distinct stages
 * over dispersed time (distinct-category COUNT), NOT monotonic
 * kill-chain progression — real attackers oscillate across stages
 * (recon → lateral move → back to recon), so no rank/order table is
 * introduced. R2 keys on the category-level `CRITICAL_CATEGORIES` set
 * (as R1 does), NOT R6's selector-level `LOWSLOW_SELECTOR_SET`.
 *
 * The distinct-category count drives BOTH the `≥ R2_MIN_CATEGORIES`
 * gate and the `score`, and is computed over the full semantic-match
 * cluster BEFORE `applyMemberCap` — mirroring `detectR6`'s pre-cap
 * dispersion. If the count were taken after the cap, a large cluster
 * could drop a whole category and destabilize the score (and even the
 * gate). So `members`/`summary` use the capped subset, but the gate and
 * score use the pre-cap cluster.
 *
 * The ≥3-bucket dispersion floor is what excludes a single-window
 * multi-category burst already covered by R1. Called ONLY from the
 * low-and-slow sweep (`baseline/lowslow-sweep.ts`), never from
 * `runStepF`, so the 24h window does not widen `MAX_RULE_WINDOW_MS`.
 * The JS hour bucketing is UTC ({@link utcHourBucket}), matching the
 * phase-1 SQL.
 *
 * R2 and R6 may both fire on the same asset/window (R2 = multi-stage
 * breadth, R6 = persistent same-character repetition); per Story RFC §9
 * (option A) the overlap is intended — both rows persist, keyed by
 * distinct `correlation_rule_id`.
 */
export function detectR2(events: ReadonlyArray<CandidateEvent>): StoryDraft[] {
  const drafts: StoryDraft[] = [];
  const byAsset = groupByAsset(events.filter((e) => e.category !== null));
  for (const [asset, perAsset] of byAsset) {
    const clusters = clusterByWindow(perAsset, LOWSLOW_WINDOW_MS);
    for (const cluster of clusters) {
      // Dispersion and the distinct-category count are computed over the
      // FULL cluster (pre-cap), so the gate and score reflect the
      // semantic match window rather than the sampled member subset.
      const buckets = new Set(cluster.map((m) => utcHourBucket(m.eventTime)));
      if (buckets.size < LOWSLOW_MIN_BUCKETS) continue;
      const distinctCategories = new Set(
        cluster.map((m) => String(m.category)),
      );
      if (distinctCategories.size < R2_MIN_CATEGORIES) continue;
      // ≥1-critical guard stays in the rule layer (simpler than encoding
      // CRITICAL_CATEGORIES in the phase-1 SQL); uses the category-level
      // set, as R1 does.
      const hasCritical = cluster.some(
        (m) =>
          m.category !== null &&
          CRITICAL_CATEGORIES.has(m.category as ThreatCategory),
      );
      if (!hasCritical) continue;
      const capped = applyMemberCap(cluster);
      const start = cluster[0].eventTime;
      const end = cluster[cluster.length - 1].eventTime;
      drafts.push({
        ruleId: "R2",
        primaryAsset: asset,
        correlationKey: null,
        timeWindowStart: start,
        timeWindowEnd: end,
        members: capped,
        score: distinctCategories.size,
        summary: buildSummaryPayload(capped),
      });
    }
  }
  return drafts;
}

/**
 * Typed registry of the shared-candidate-set rules (R1/R3). Adding a
 * future rule that reads the same broad candidate set is a
 * registry-level change.
 *
 * R4/R5 are intentionally NOT registered here: per Story RFC §10
 * (option (a)) they require their own predicate-pushed candidate
 * reads (`readR4Candidates` / `readR5Candidates`, which select
 * `resp_addr` and pre-aggregate on different keys) and so do not fit
 * the `(events) => StoryDraft[]` shared-set signature. They are wired
 * directly in the correlator (`correlator.ts`
 * `runStoryCorrelationForWindow`) alongside their reads.
 *
 * R6 and R2 are likewise NOT registered: both run only from the hourly
 * low-and-slow sweep (`baseline/lowslow-sweep.ts`) over a 24h window,
 * never from per-page step (f). Adding either here would pull its
 * detector into the cadence path and widen `MAX_RULE_WINDOW_MS` to 24h.
 */
export const RULE_REGISTRY: ReadonlyArray<{
  id: StoryRuleId;
  detect: (events: ReadonlyArray<CandidateEvent>) => StoryDraft[];
}> = [
  { id: "R1", detect: detectR1 },
  { id: "R3", detect: detectR3 },
];

/**
 * Run every active rule against the candidate set and return the
 * union of drafts. The correlator's finalization filter (slop
 * window) decides which drafts persist on this tick versus the
 * next.
 */
export function detectAllStories(
  events: ReadonlyArray<CandidateEvent>,
): StoryDraft[] {
  const out: StoryDraft[] = [];
  for (const rule of RULE_REGISTRY) {
    for (const d of rule.detect(events)) out.push(d);
  }
  return out;
}
