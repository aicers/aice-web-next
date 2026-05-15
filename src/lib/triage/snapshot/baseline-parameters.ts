/**
 * Live capture of the baseline tunables module
 * (`src/lib/triage/baseline/tunables.ts`) for
 * `baseline_version_snapshot.parameters`.
 *
 * A bump in any value in that module requires a `baseline_version`
 * bump (per `tunables.ts` §10), so this capture is invariant for a
 * given version: one snapshot row per version, written via
 * `ON CONFLICT (version) DO NOTHING`. The capture is pure and
 * deterministic; tests assert it round-trips a known shape.
 */

import {
  FINAL_COUNT,
  MAX_TAGS,
  SELECTOR_SATURATION,
  SELECTOR_TAGS,
  SELECTOR_WEIGHTS,
  SLOT_ALLOCATION,
  STATISTICS_WINDOW_DAYS,
  TAG_THRESHOLDS,
} from "@/lib/triage/baseline/tunables";

import type { BaselineVersionParameters } from "./types";

export function currentBaselineParameters(): BaselineVersionParameters {
  return {
    selectorWeights: {
      w_S1: SELECTOR_WEIGHTS.w_S1,
      w_S2: SELECTOR_WEIGHTS.w_S2,
      w_S3: SELECTOR_WEIGHTS.w_S3,
      w_S4: SELECTOR_WEIGHTS.w_S4,
      w_UNLABELED: SELECTOR_WEIGHTS.w_UNLABELED,
    },
    selectorSaturation: {
      R: SELECTOR_SATURATION.R,
      C: SELECTOR_SATURATION.C,
    },
    tagThresholds: {
      s1_high: TAG_THRESHOLDS.s1_high,
      s3_recurring: TAG_THRESHOLDS.s3_recurring,
      s4_correlated: TAG_THRESHOLDS.s4_correlated,
    },
    slotAllocation: {
      base_share: SLOT_ALLOCATION.base_share,
      alpha: SLOT_ALLOCATION.alpha,
      beta: SLOT_ALLOCATION.beta,
    },
    finalCount: {
      LOWER_FLOOR: FINAL_COUNT.LOWER_FLOOR,
      scale: FINAL_COUNT.scale,
      MIN_NONZERO_FLOOR: FINAL_COUNT.MIN_NONZERO_FLOOR,
    },
    statisticsWindowDays: [...STATISTICS_WINDOW_DAYS],
    maxTags: MAX_TAGS,
    selectorTags: {
      S1_HIGH: SELECTOR_TAGS.S1_HIGH,
      S2_SEVERE: SELECTOR_TAGS.S2_SEVERE,
      S3_RECURRING: SELECTOR_TAGS.S3_RECURRING,
      S4_CORRELATED: SELECTOR_TAGS.S4_CORRELATED,
      UNLABELED_CLUSTER: SELECTOR_TAGS.UNLABELED_CLUSTER,
    },
  };
}
