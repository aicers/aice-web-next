/**
 * Type declarations for the Phase 1.B menu composition runtime.
 * Sibling to `compose.mjs`; consumed by both the production caller
 * (via the `menu.ts` re-export) and the harness's TypeScript helpers
 * (via `scripts/measure-baseline-read-path.d.ts`).
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

export interface SlotBucket {
  kind: string;
  isUnlabeled: boolean;
}

export interface BucketAggregate {
  bucket: SlotBucket;
  count: number;
  totalTagCardinality: number;
}

/**
 * Per-bucket engagement aggregate carried into `composeMenu` per
 * RFC 0003 §9.1. The menu loader executes the §7 aggregate SQL,
 * applies §5.2 / §6 gates, and passes the resulting array. Absence
 * (`bucketEngagement === undefined`) collapses the engagement term
 * to zero — legacy callers, unit tests, and the kill-switch path.
 */
export interface BucketEngagement {
  /** `${kind}:${is_unlabeled}` — same shape as {@link bucketKey}. */
  bucketKey: string;
  /** EWMA-weighted rate in [0, 1] over the active window (§5.3). */
  engagementRate: number;
  /**
   * Raw `COUNT(*)` per the §5.2 `N_min` gate — NOT the EWMA-weighted
   * denominator used in the rate. Below `perBucketMinImpressions`
   * the engagement signal is suppressed for that bucket.
   */
  impressionCount: number;
  /** 7 / 14 / 30 — for audit / debugging. */
  windowDays: 7 | 14 | 30;
}

export interface ComposeMenuInput {
  postExclusionCount: number;
  bucketAggregates: ReadonlyArray<BucketAggregate>;
  candidates: ReadonlyArray<MenuRow>;
  cutoff: number;
  /**
   * #471 §5: scales `composeMenu`'s `defaultN`. `null` lifts the
   * per-bucket quota entirely (the "All" stop). `undefined` falls
   * back to a multiplier of 1 — legacy callers and tests that have
   * not opted into option (b).
   */
  defaultNMultiplier?: number | null;
  /**
   * RFC 0003 §9.1: per-bucket engagement aggregate. When absent the
   * engagement term (§4 `γ · engagement_signal(b)`) is zero for
   * every bucket — RFC 0001-equivalent.
   */
  bucketEngagement?: ReadonlyArray<BucketEngagement>;
  /**
   * RFC 0003 §8.1 — the `engagement_model_version` in effect at
   * menu-load time. Threaded by the loader so the impression batch
   * can stamp it on every row. Not consumed by `composeMenu`
   * itself; carried for the caller's convenience.
   */
  engagementModelVersion?: string;
}

export interface AssembleResult {
  rows: MenuRow[];
  quotas: ReadonlyMap<string, number>;
  assembledCount: number;
  fallbackInvoked: boolean;
  defaultN: number;
}

export interface CohortInputRow {
  event_key: string;
  event_time: Date | string;
  kind: string;
  baseline_version: string;
  raw_score: number;
  baseline_score: number | null;
  selector_tags: string[];
  is_unlabeled: boolean;
  bucket_count: string | number;
  bucket_tag_sum: string | number;
  cohort_count: string | number;
  orig_addr: string | null;
}

export interface CohortShape {
  postExclusionCount: number;
  bucketAggregates: BucketAggregate[];
  candidates: MenuRow[];
}

export declare const DEFAULT_MENU_CUTOFF: number;

export declare function slotBucket(
  kind: string,
  selectorTags: string[],
): SlotBucket;
export declare function bucketKey(b: SlotBucket): string;
export declare function computeDefaultN(postExclusionCount: number): number;
export declare function computeBucketQuotas(
  aggregates: ReadonlyArray<BucketAggregate>,
  defaultN: number,
  engagementSignalMap?: ReadonlyMap<string, number>,
  gamma?: number,
): Map<string, number>;
export declare function compareEventKeyDesc(a: string, b: string): number;
export declare function composeMenu(input: ComposeMenuInput): AssembleResult;
export declare function assembleMenu(
  rows: ReadonlyArray<MenuRow>,
  cutoff: number,
): AssembleResult;
export declare function buildCohortFromRows(
  rows: ReadonlyArray<CohortInputRow>,
): CohortShape;
export declare function addressesFromCohortRows(
  rows: ReadonlyArray<CohortInputRow>,
  opts?: { cutoff?: number; limit?: number },
): string[];

export declare const _inlinedConstants: {
  HTTP_THREAT_KIND: string;
  UNLABELED_TAG: string;
  MAX_TAGS: number;
  SLOT_ALLOCATION: { base_share: number; alpha: number; beta: number };
  FINAL_COUNT: {
    LOWER_FLOOR: number;
    scale: number;
    MIN_NONZERO_FLOOR: number;
  };
  FAVORED_BUCKETS: ReadonlySet<string>;
  ENGAGEMENT_TUNABLES: {
    gamma: number;
    perBucketMinImpressions: number;
    ewmaHalfLifeWindowRatio: number;
    explorationShare: number;
    tenantColdStartMinImpressions: number;
    includedShownBy: ReadonlyArray<string>;
    engagedActions: ReadonlyArray<string>;
    activeWindowsDays: ReadonlyArray<number>;
    engagementModelVersion: string;
  };
};

export declare const _testing: {
  tieBreakerCompare: (a: MenuRow, b: MenuRow) => number;
  shareForBucket: (
    agg: BucketAggregate,
    maxCount: number,
    engagementSignal: number,
    gamma: number,
  ) => number;
  computeBucketQuotasWithExploration: (
    aggregates: ReadonlyArray<BucketAggregate>,
    defaultN: number,
    engagementSignalMap: ReadonlyMap<string, number>,
    gamma: number,
    explorationShare: number,
  ) => Map<string, number>;
  buildEngagementSignalMap: (
    bucketEngagement:
      | ReadonlyArray<{
          bucketKey: string;
          engagementRate: number;
          impressionCount: number;
        }>
      | undefined,
    perBucketMinImpressions: number,
  ) => Map<string, number>;
};
