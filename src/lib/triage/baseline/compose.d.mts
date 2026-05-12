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

export interface ComposeMenuInput {
  postExclusionCount: number;
  bucketAggregates: ReadonlyArray<BucketAggregate>;
  candidates: ReadonlyArray<MenuRow>;
  cutoff: number;
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
  selector_tags: string[] | null;
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
};

export declare const _testing: {
  tieBreakerCompare: (a: MenuRow, b: MenuRow) => number;
  shareForBucket: (agg: BucketAggregate, maxCount: number) => number;
};
