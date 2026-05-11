/**
 * Phase 1.B menu composition (RFC 0001 §3 steps (4)–(7), §4, §6).
 *
 * Pure functions that turn a window of scored corpus rows into the
 * `final_menu_rows` set the Triage menu shows. Algorithm steps:
 *
 *   (4) `baseline_score` is computed by the SQL caller via
 *       `cume_dist() OVER (PARTITION BY kind, baseline_version
 *       ORDER BY raw_score)` and attached to each row before this
 *       module sees it. The math here treats `baseline_score` as a
 *       precomputed scalar in `[0, 1]`.
 *   (5) per-bucket quotas via largest-remainder against `default_N`.
 *   (6) per-bucket cohort union → cutoff filter → ORDER BY
 *       `baseline_score DESC` with the §3 tie-breaker → take
 *       quota[b]. `quota[b]` applies once per bucket across
 *       `baseline_version`s, never per cohort.
 *   (7) `MIN_NONZERO_FLOOR` fallback when `assembled_count` falls
 *       below the floor: replace the assembly with the top
 *       `MIN_NONZERO_FLOOR` rows globally by `baseline_score DESC`,
 *       bypassing both quota and cutoff.
 *
 * The cutoff parameter is the read-time slider boundary owned by
 * #471 — production callers pass `0` (no cutoff) so output is
 * determined entirely by quota / fallback; tests inject strict
 * cutoffs to exercise the cutoff branch and the floor fallback.
 */

import { FAVORED_BUCKETS } from "./categories";
import {
  FINAL_COUNT,
  MAX_TAGS,
  SELECTOR_TAGS,
  SLOT_ALLOCATION,
} from "./tunables";

const HTTP_THREAT_KIND = "HttpThreat";
const UNLABELED_TAG = SELECTOR_TAGS.UNLABELED_CLUSTER;

/**
 * Minimum row shape the algorithm reads. Callers attach the read-time
 * `cume_dist()` value as `baselineScore` before passing rows in.
 */
export interface MenuRow {
  eventKey: string;
  eventTime: Date;
  kind: string;
  baselineVersion: string;
  rawScore: number;
  baselineScore: number;
  selectorTags: string[];
}

/**
 * `slot_bucket(event)` from RFC §4 — `('HttpThreat', true)` when the
 * row is unlabeled-cluster HttpThreat, `(kind, false)` everywhere
 * else. Encoded as `"<kind>:<is_unlabeled>"` so it can be used as a
 * Map key and matched against {@link FAVORED_BUCKETS} membership.
 */
export interface SlotBucket {
  kind: string;
  isUnlabeled: boolean;
}

export function slotBucket(kind: string, selectorTags: string[]): SlotBucket {
  if (kind === HTTP_THREAT_KIND && selectorTags.includes(UNLABELED_TAG)) {
    return { kind, isUnlabeled: true };
  }
  return { kind, isUnlabeled: false };
}

export function bucketKey(b: SlotBucket): string {
  return `${b.kind}:${b.isUnlabeled}`;
}

/**
 * Sublinear `default_N` curve from RFC §6:
 *   `round(LOWER_FLOOR + scale * log10(1 + post_exclusion))`.
 *
 * `post_exclusion` is the count after the §1 `BlockList*` filter —
 * i.e. the size of the cohort feeding the algorithm.
 */
export function computeDefaultN(postExclusionCount: number): number {
  const { LOWER_FLOOR, scale } = FINAL_COUNT;
  const n =
    LOWER_FLOOR + scale * Math.log10(1 + Math.max(0, postExclusionCount));
  return Math.round(n);
}

interface BucketAggregate {
  bucket: SlotBucket;
  count: number;
  totalTagCardinality: number;
}

/**
 * `normalized_volume(b) ∈ [0, 1]` and `normalized_top_confidence(b) ∈
 * [0, 1]` from RFC §4. `normalized_top_confidence` uses
 * `avg(coalesce(cardinality(selector_tags), 0)) / MAX_TAGS` per RFC
 * §4 — the `coalesce` is mandatory because zero-tag rows would
 * otherwise silently drop from the average and an all-empty group
 * would produce `NaN` rather than `0`.
 */
function shareForBucket(agg: BucketAggregate, maxCount: number): number {
  const normalizedVolume = maxCount > 0 ? agg.count / maxCount : 0;
  const avgTagLen = agg.count > 0 ? agg.totalTagCardinality / agg.count : 0;
  const normalizedTopConfidence = MAX_TAGS > 0 ? avgTagLen / MAX_TAGS : 0;
  const favored = FAVORED_BUCKETS.has(bucketKey(agg.bucket))
    ? SLOT_ALLOCATION.beta
    : 0;
  return (
    SLOT_ALLOCATION.base_share +
    SLOT_ALLOCATION.alpha * normalizedVolume * normalizedTopConfidence +
    favored
  );
}

/**
 * Largest-remainder quota distribution from RFC §4. `defaultN`
 * slots are split among buckets so the per-bucket integer quotas
 * sum to exactly `defaultN` — independent rounding does not satisfy
 * the cap, hence largest-remainder. Ties on `remainder[b]` resolve
 * lexicographically by `(kind, is_unlabeled)` with `false < true`
 * per RFC §4 — the tie-breaker exists only to keep the allocation
 * fully deterministic when two buckets land on the same remainder.
 */
export function computeBucketQuotas(
  aggregates: ReadonlyArray<BucketAggregate>,
  defaultN: number,
): Map<string, number> {
  const quotas = new Map<string, number>();
  if (aggregates.length === 0 || defaultN <= 0) return quotas;

  const maxCount = aggregates.reduce((m, a) => Math.max(m, a.count), 0);
  const rawShares = aggregates.map((a) => ({
    bucket: a.bucket,
    share: shareForBucket(a, maxCount),
  }));
  const shareSum = rawShares.reduce((s, r) => s + r.share, 0);
  if (shareSum <= 0) return quotas;

  const ideal = rawShares.map((r) => ({
    bucket: r.bucket,
    ideal: (r.share / shareSum) * defaultN,
  }));

  const floors = ideal.map((r) => ({
    bucket: r.bucket,
    floor: Math.floor(r.ideal),
    remainder: r.ideal - Math.floor(r.ideal),
  }));

  const sumFloors = floors.reduce((s, f) => s + f.floor, 0);
  let leftover = defaultN - sumFloors;
  // Leftover is bounded by the number of buckets minus the count
  // already used by floors. Negative leftover only arises from
  // floating-point drift; clamp defensively.
  if (leftover < 0) leftover = 0;
  if (leftover > floors.length) leftover = floors.length;

  const ranked = [...floors].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    if (a.bucket.kind !== b.bucket.kind)
      return a.bucket.kind < b.bucket.kind ? -1 : 1;
    // `false < true` per RFC §4 lexicographic order.
    if (a.bucket.isUnlabeled === b.bucket.isUnlabeled) return 0;
    return a.bucket.isUnlabeled ? 1 : -1;
  });

  for (const f of floors) {
    quotas.set(bucketKey(f.bucket), f.floor);
  }
  for (let i = 0; i < leftover && i < ranked.length; i++) {
    const k = bucketKey(ranked[i].bucket);
    quotas.set(k, (quotas.get(k) ?? 0) + 1);
  }
  return quotas;
}

/**
 * §3 tie-breaker tuple: `(baseline_score DESC, event_time DESC,
 * event_key DESC)`. The i128 `event_key` is unique, so the order is
 * total. `event_key` is compared as a numeric string (lexicographic
 * works when both keys are the same width; corpus A's event_key is
 * NUMERIC(39,0) so callers stringify it with `::text` — we cope with
 * both same-width and variable-width strings by comparing length
 * first, then lexicographically).
 */
function tieBreakerCompare(a: MenuRow, b: MenuRow): number {
  if (a.baselineScore !== b.baselineScore)
    return b.baselineScore - a.baselineScore;
  if (a.eventTime.getTime() !== b.eventTime.getTime())
    return b.eventTime.getTime() - a.eventTime.getTime();
  if (a.eventKey.length !== b.eventKey.length)
    return b.eventKey.length - a.eventKey.length;
  if (a.eventKey === b.eventKey) return 0;
  return a.eventKey < b.eventKey ? 1 : -1;
}

export interface AssembleResult {
  rows: MenuRow[];
  /** Per-bucket quotas produced by the largest-remainder pass. */
  quotas: ReadonlyMap<string, number>;
  /** Pre-fallback `assembled_count` from §4. */
  assembledCount: number;
  /**
   * `true` when the §6 `MIN_NONZERO_FLOOR` global-fallback path
   * replaced the assembled rows.
   */
  fallbackInvoked: boolean;
  /** `default_N` from §6 — the cognitive-limit cap. */
  defaultN: number;
}

/**
 * Compose the menu from the in-window cohort.
 *
 * Cutoff semantics (RFC §6, owned by #471): production callers pass
 * `cutoff = 0` (no additional cutoff above the cohort), so output is
 * determined entirely by quota and — when assembly is below the
 * floor — the global fallback. Tests pass strict cutoffs to drive
 * the cutoff branch.
 */
export function assembleMenu(
  rows: ReadonlyArray<MenuRow>,
  cutoff: number,
): AssembleResult {
  const postExclusionCount = rows.length;
  const defaultN = computeDefaultN(postExclusionCount);

  // Bucket aggregates over the *full* post-exclusion cohort — `coalesce`
  // on tag cardinality is built into the `selectorTags.length` call
  // because TS arrays always have a length (RFC §4's `coalesce` guard
  // is needed only on the SQL side where `array_length('{}', 1)` is
  // NULL).
  const bucketAggMap = new Map<string, BucketAggregate>();
  for (const row of rows) {
    const b = slotBucket(row.kind, row.selectorTags);
    const k = bucketKey(b);
    const agg = bucketAggMap.get(k);
    if (agg === undefined) {
      bucketAggMap.set(k, {
        bucket: b,
        count: 1,
        totalTagCardinality: row.selectorTags.length,
      });
    } else {
      agg.count += 1;
      agg.totalTagCardinality += row.selectorTags.length;
    }
  }
  const aggregates = Array.from(bucketAggMap.values());
  const quotas = computeBucketQuotas(aggregates, defaultN);

  // Per-bucket cohort union → cutoff filter → ORDER BY → quota[b].
  // RFC §4: `quota[b]` is the cap *across* baseline_versions, so the
  // union is implicit in grouping rows by `slot_bucket` (which does
  // not include `baseline_version`) before sorting.
  const byBucket = new Map<string, MenuRow[]>();
  for (const row of rows) {
    if (row.baselineScore < cutoff) continue;
    const k = bucketKey(slotBucket(row.kind, row.selectorTags));
    const list = byBucket.get(k);
    if (list === undefined) byBucket.set(k, [row]);
    else list.push(row);
  }

  const assembled: MenuRow[] = [];
  for (const [k, list] of byBucket) {
    const cap = quotas.get(k) ?? 0;
    if (cap <= 0) continue;
    list.sort(tieBreakerCompare);
    for (let i = 0; i < cap && i < list.length; i++) {
      assembled.push(list[i]);
    }
  }

  const assembledCount = assembled.length;
  if (assembledCount >= FINAL_COUNT.MIN_NONZERO_FLOOR) {
    // Sort the assembled rows into a single deterministic order so
    // the pivot index and the asset-detail render in `baseline_score`
    // DESC order with the §3 tie-breaker.
    assembled.sort(tieBreakerCompare);
    return {
      rows: assembled,
      quotas,
      assembledCount,
      fallbackInvoked: false,
      defaultN,
    };
  }

  // §6 fallback: top MIN_NONZERO_FLOOR globally by `baseline_score
  // DESC`, bypassing both quota and cutoff. `post_exclusion = 0`
  // returns an empty list because there is nothing to fall back on.
  if (postExclusionCount === 0) {
    return {
      rows: [],
      quotas,
      assembledCount: 0,
      fallbackInvoked: false,
      defaultN,
    };
  }
  const all = [...rows];
  all.sort(tieBreakerCompare);
  const floor = Math.min(FINAL_COUNT.MIN_NONZERO_FLOOR, all.length);
  return {
    rows: all.slice(0, floor),
    quotas,
    assembledCount,
    fallbackInvoked: true,
    defaultN,
  };
}

export const _testing = {
  tieBreakerCompare,
  shareForBucket,
};
