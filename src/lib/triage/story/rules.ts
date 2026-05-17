/**
 * Story v1 heuristic rule set (Story RFC §3, §7, §8).
 *
 * Pure predicate functions over an in-memory candidate event set. No
 * database access — the correlator (`./correlator.ts`) reads the
 * candidate set from `baseline_triaged_event` and threads it through
 * these rules before writing the resulting drafts via
 * `./repository.ts`.
 *
 * Two conservative rules ship in v1:
 *
 *   - R1 — same `primary_asset` (orig_addr), within a 10-minute window,
 *     has events from ≥2 distinct categories in the critical-category
 *     set.
 *   - R3 — same `primary_asset` has ≥3 events whose `selector_tags`
 *     overlap the critical-selector set within a 1-hour window.
 *
 * R2 (kill-chain progression) is reserved for the v2 Story RFC bump;
 * the `'R2'` slot stays empty so the rule-ID enum does not shift.
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
import { CRITICAL_SELECTOR_SET as CRITICAL_SELECTOR_SET_RAW } from "@/lib/triage/story/critical-sets.mjs";

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
 * Maximum rule window. The slop-replay protocol uses this as the
 * member-scan lookback so an R3 cluster whose `time_window_end` falls
 * just past the previous watermark can still pick up members that sit
 * before the watermark but inside the rule window.
 */
export const MAX_RULE_WINDOW_MS = Math.max(R1_WINDOW_MS, R3_WINDOW_MS);

/**
 * Slop-window length applied at finalization (Story RFC §3 / §4). A
 * cluster whose `time_window_end` is within the last `SLOP_WINDOW_MS`
 * of the page's `event_time` range is deferred to a subsequent tick.
 */
export const SLOP_WINDOW_MS = 30 * 60 * 1000;

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
 * Active rule IDs the v1 correlator emits. `'R2'` is intentionally
 * absent — the slot is reserved by the Story RFC v1 for the v2 bump.
 */
export const ACTIVE_RULE_IDS = ["R1", "R3"] as const;
export type StoryRuleId = (typeof ACTIVE_RULE_IDS)[number];

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
  primaryAsset: string;
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
 * Typed registry of v1 rules. Adding a future rule is purely a
 * registry-level change — schema stays the same.
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
