import { describe, expect, it } from "vitest";

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
import { currentBaselineParameters } from "@/lib/triage/snapshot/baseline-parameters";

describe("currentBaselineParameters", () => {
  it("captures every group exported from tunables.ts", () => {
    const captured = currentBaselineParameters();
    expect(captured.selectorWeights).toEqual({
      w_S1: SELECTOR_WEIGHTS.w_S1,
      w_S2: SELECTOR_WEIGHTS.w_S2,
      w_S3: SELECTOR_WEIGHTS.w_S3,
      w_S4: SELECTOR_WEIGHTS.w_S4,
      w_UNLABELED: SELECTOR_WEIGHTS.w_UNLABELED,
    });
    expect(captured.selectorSaturation).toEqual({
      R: SELECTOR_SATURATION.R,
      C: SELECTOR_SATURATION.C,
    });
    expect(captured.tagThresholds).toEqual({
      s1_high: TAG_THRESHOLDS.s1_high,
      s3_recurring: TAG_THRESHOLDS.s3_recurring,
      s4_correlated: TAG_THRESHOLDS.s4_correlated,
    });
    expect(captured.slotAllocation).toEqual({
      base_share: SLOT_ALLOCATION.base_share,
      alpha: SLOT_ALLOCATION.alpha,
      beta: SLOT_ALLOCATION.beta,
    });
    expect(captured.finalCount).toEqual({
      LOWER_FLOOR: FINAL_COUNT.LOWER_FLOOR,
      scale: FINAL_COUNT.scale,
      MIN_NONZERO_FLOOR: FINAL_COUNT.MIN_NONZERO_FLOOR,
    });
    expect(captured.statisticsWindowDays).toEqual([...STATISTICS_WINDOW_DAYS]);
    expect(captured.maxTags).toBe(MAX_TAGS);
    expect(captured.selectorTags).toEqual({
      S1_HIGH: SELECTOR_TAGS.S1_HIGH,
      S2_SEVERE: SELECTOR_TAGS.S2_SEVERE,
      S3_RECURRING: SELECTOR_TAGS.S3_RECURRING,
      S4_CORRELATED: SELECTOR_TAGS.S4_CORRELATED,
      UNLABELED_CLUSTER: SELECTOR_TAGS.UNLABELED_CLUSTER,
    });
  });

  it("is deterministic — two calls yield deep-equal snapshots", () => {
    expect(currentBaselineParameters()).toEqual(currentBaselineParameters());
  });
});
