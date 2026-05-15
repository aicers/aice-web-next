// Phase 1.B menu composition runtime (RFC 0001 §3 (4)–(7), §4, §6).
//
// Plain ESM so both the production caller (TypeScript, via the
// re-export shim in `menu.ts`) and the measurement harness (plain
// Node, via the relative import from `scripts/`) execute the SAME
// composition code. Inlining the algorithm into `.mjs` is the
// solution Round 2 of the #524 review asked for: the harness no
// longer measures a SQL-only superset of the addresses production
// surfaces — it replays the full `selectMenuCohort → composeMenu →
// uniqueAddresses` pipeline against the same cohort rows.
//
// Module constraints (issue #524 §4, mirrors `read-path-sql.mjs`):
//
//   * No `import "server-only"`, no `next/*`, no `process.env` at
//     import time. The harness loads this module from plain Node.
//   * Pure functions — no Pool, no DB connection, no logging.
//   * Type declarations live in the sibling `compose.d.ts`.
//
// Constants below are inlined for the plain-Node constraint;
// `tunables.ts` and `categories.ts` remain the canonical TS source.
// `src/__tests__/lib/triage/baseline/compose-constants-drift.test.ts`
// asserts the two copies stay in sync so a future tunable change
// trips a single, obvious test.

const HTTP_THREAT_KIND = "HttpThreat";
const UNLABELED_TAG = "unlabeled-cluster";
const MAX_TAGS = 5;
const SLOT_ALLOCATION = {
  base_share: 0.02,
  alpha: 1.0,
  beta: 0.1,
};
const FINAL_COUNT = {
  LOWER_FLOOR: 20,
  scale: 30,
  MIN_NONZERO_FLOOR: 1,
};
const FAVORED_BUCKETS = new Set([
  "DnsCovertChannel:false",
  "HttpThreat:true",
  "LockyRansomware:false",
  "RepeatedHttpSessions:false",
  "SuspiciousTlsTraffic:false",
]);

/** RFC §6 default cutoff used by production callers (`#471` owns the dial). */
export const DEFAULT_MENU_CUTOFF = 0;

/** Inlined-tunable accessors, for the drift test. */
export const _inlinedConstants = {
  HTTP_THREAT_KIND,
  UNLABELED_TAG,
  MAX_TAGS,
  SLOT_ALLOCATION,
  FINAL_COUNT,
  FAVORED_BUCKETS,
};

export function slotBucket(kind, selectorTags) {
  if (kind === HTTP_THREAT_KIND && selectorTags.includes(UNLABELED_TAG)) {
    return { kind, isUnlabeled: true };
  }
  return { kind, isUnlabeled: false };
}

export function bucketKey(b) {
  return `${b.kind}:${b.isUnlabeled}`;
}

export function computeDefaultN(postExclusionCount) {
  const n =
    FINAL_COUNT.LOWER_FLOOR +
    FINAL_COUNT.scale * Math.log10(1 + Math.max(0, postExclusionCount));
  return Math.round(n);
}

function shareForBucket(agg, maxCount) {
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

export function computeBucketQuotas(aggregates, defaultN) {
  const quotas = new Map();
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
  if (leftover < 0) leftover = 0;
  if (leftover > floors.length) leftover = floors.length;

  const ranked = [...floors].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    if (a.bucket.kind !== b.bucket.kind)
      return a.bucket.kind < b.bucket.kind ? -1 : 1;
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

export function compareEventKeyDesc(a, b) {
  if (a.length !== b.length) return b.length - a.length;
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function tieBreakerCompare(a, b) {
  if (a.baselineScore !== b.baselineScore)
    return b.baselineScore - a.baselineScore;
  if (a.eventTime.getTime() !== b.eventTime.getTime())
    return b.eventTime.getTime() - a.eventTime.getTime();
  return compareEventKeyDesc(a.eventKey, b.eventKey);
}

export function composeMenu(input) {
  const { postExclusionCount, bucketAggregates, candidates, cutoff } = input;
  const defaultN = computeDefaultN(postExclusionCount);
  const quotas = computeBucketQuotas(bucketAggregates, defaultN);

  const byBucket = new Map();
  for (const row of candidates) {
    if (row.baselineScore < cutoff) continue;
    const k = bucketKey(slotBucket(row.kind, row.selectorTags));
    const list = byBucket.get(k);
    if (list === undefined) byBucket.set(k, [row]);
    else list.push(row);
  }

  const assembled = [];
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
    assembled.sort(tieBreakerCompare);
    return {
      rows: assembled,
      quotas,
      assembledCount,
      fallbackInvoked: false,
      defaultN,
    };
  }

  if (postExclusionCount === 0) {
    return {
      rows: [],
      quotas,
      assembledCount: 0,
      fallbackInvoked: false,
      defaultN,
    };
  }
  // The fallback must respect the slider cutoff — a strict stop
  // promises "no row below `baseline_score >= cutoff`", and surfacing
  // a sub-cutoff row at e.g. `top5` would contradict the RFC §1 stop
  // contract and the "incident response, only the strongest signals"
  // use case. When every row sits below the cutoff, the fallback
  // returns empty rather than dipping under the user's selection.
  const surviving = candidates.filter((row) => row.baselineScore >= cutoff);
  if (surviving.length === 0) {
    return {
      rows: [],
      quotas,
      assembledCount: 0,
      fallbackInvoked: false,
      defaultN,
    };
  }
  surviving.sort(tieBreakerCompare);
  const floor = Math.min(FINAL_COUNT.MIN_NONZERO_FLOOR, surviving.length);
  return {
    rows: surviving.slice(0, floor),
    quotas,
    assembledCount,
    fallbackInvoked: true,
    defaultN,
  };
}

export function assembleMenu(rows, cutoff) {
  const bucketAggMap = new Map();
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
  return composeMenu({
    postExclusionCount: rows.length,
    bucketAggregates: Array.from(bucketAggMap.values()),
    candidates: rows,
    cutoff,
  });
}

export const _testing = {
  tieBreakerCompare,
  shareForBucket,
};

/**
 * Convert the raw `SELECT_MENU_COHORT_SQL` row shape into the
 * `{postExclusionCount, bucketAggregates, candidates}` triple that
 * `composeMenu` consumes. Mirrors `buildCohort` in `server-actions.ts`
 * — once both callers route through this helper there is one place to
 * change the SQL-row → algorithm-input mapping.
 *
 * @param {ReadonlyArray<{
 *   event_key: string,
 *   event_time: Date | string,
 *   kind: string,
 *   baseline_version: string,
 *   raw_score: number,
 *   baseline_score: number | null,
 *   selector_tags: string[] | null,
 *   is_unlabeled: boolean,
 *   bucket_count: string | number,
 *   bucket_tag_sum: string | number,
 *   cohort_count: string | number,
 *   orig_addr: string | null,
 * }>} rows
 */
export function buildCohortFromRows(rows) {
  if (rows.length === 0) {
    return { postExclusionCount: 0, bucketAggregates: [], candidates: [] };
  }
  const postExclusionCount = Number(rows[0].cohort_count);
  const seenBuckets = new Map();
  for (const row of rows) {
    const bucket = { kind: row.kind, isUnlabeled: row.is_unlabeled };
    const key = bucketKey(bucket);
    if (seenBuckets.has(key)) continue;
    seenBuckets.set(key, {
      bucket,
      count: Number(row.bucket_count),
      totalTagCardinality: Number(row.bucket_tag_sum),
    });
  }
  return {
    postExclusionCount,
    bucketAggregates: Array.from(seenBuckets.values()),
    candidates: rows.map((r) => ({
      eventKey: r.event_key,
      eventTime:
        r.event_time instanceof Date ? r.event_time : new Date(r.event_time),
      kind: r.kind,
      baselineVersion: r.baseline_version,
      rawScore: r.raw_score,
      baselineScore: r.baseline_score ?? 0,
      selectorTags: r.selector_tags ?? [],
    })),
  };
}

/**
 * Production-equivalent address derivation, given the raw cohort SQL
 * rows. Replays `composeMenuFromCohort` (cutoff = 0) and then
 * `uniqueAddresses(events)` — same code path as
 * `loadTriagePeriod` in `server-actions.ts`. Returns the addresses
 * the planner will see in `perAssetObservedCounts` /
 * `selectAssetDetailEventsBatch` for one menu load, in insertion
 * order (production also calls `Array.from(new Set(...))`).
 *
 * The measurement harness in `scripts/measure-baseline-read-path.mjs`
 * deliberately calls this helper WITHOUT `opts.limit`, mirroring
 * production: `loadCustomerSlice` drives the per-tenant fanout from
 * the uncapped `uniqueAddresses(events)` (`server-actions.ts:217-223`)
 * and the `TRIAGE_ASSET_PAGE_SIZE` cap only applies to the aggregated
 * asset list at the very end of `loadTriagePeriod`
 * (`server-actions.ts:533`). `opts.limit` is retained as a general-
 * purpose escape hatch for callers that DO want a bounded slice
 * (e.g. unit tests), but should NOT be used to approximate the
 * production read-path cardinality — that approximation was the bug
 * fixed in Round 3 of #524 review.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows raw rows from
 *   `SELECT_MENU_COHORT_SQL`.
 * @param {object} [opts]
 * @param {number} [opts.cutoff] cutoff (production = 0).
 * @param {number} [opts.limit] optional cap on the returned address
 *   list; defaults to unbounded. Not used by the harness or
 *   production read path.
 */
export function addressesFromCohortRows(rows, opts = {}) {
  const cutoff = opts.cutoff ?? DEFAULT_MENU_CUTOFF;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const cohort = buildCohortFromRows(rows);
  const result = composeMenu({
    postExclusionCount: cohort.postExclusionCount,
    bucketAggregates: cohort.bucketAggregates,
    candidates: cohort.candidates,
    cutoff,
  });
  const origAddrByKey = new Map();
  for (const r of rows) {
    if (!origAddrByKey.has(r.event_key)) {
      origAddrByKey.set(r.event_key, r.orig_addr ?? null);
    }
  }
  const seen = new Set();
  const out = [];
  for (const menuRow of result.rows) {
    const addr = origAddrByKey.get(menuRow.eventKey);
    if (addr === null || addr === undefined) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
    if (out.length >= limit) break;
  }
  return out;
}
