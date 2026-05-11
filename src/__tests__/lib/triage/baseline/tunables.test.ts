import { describe, expect, it } from "vitest";

import { PHASE_1B_BASELINE_VERSION } from "@/lib/triage/baseline/cadence";
import {
  CRITICAL_CATEGORIES,
  FAVORED_BUCKETS,
} from "@/lib/triage/baseline/categories";
import {
  FINAL_COUNT,
  MAX_TAGS,
  SELECTOR_SATURATION,
  SELECTOR_WEIGHTS,
  SLOT_ALLOCATION,
} from "@/lib/triage/baseline/tunables";

describe("§9 tunables skeleton (PR 1 / #512)", () => {
  it("freezes the Phase 1.B baseline-version marker", () => {
    // Bumping this value here without also bumping the migration that
    // backfills `raw_score` and `selector_tags` would mark fresh rows
    // under a version the corpus has not yet stabilised on. Keep them
    // in lockstep.
    expect(PHASE_1B_BASELINE_VERSION).toBe("phase1b-four-selector");
  });

  it("exposes the provisional §9 selector weights from the RFC", () => {
    expect(SELECTOR_WEIGHTS).toEqual({
      w_S1: 1.0,
      w_S2: 1.5,
      w_S3: 0.8,
      w_S4: 0.8,
      w_UNLABELED: 0.5,
    });
  });

  it("exposes the provisional §9 saturation caps", () => {
    expect(SELECTOR_SATURATION).toEqual({ R: 10, C: 4 });
  });

  it("exposes the provisional §4 slot-allocation tunables", () => {
    expect(SLOT_ALLOCATION).toEqual({
      base_share: 0.02,
      alpha: 1.0,
      beta: 0.1,
    });
  });

  it("exposes the §9 MAX_TAGS denominator", () => {
    expect(MAX_TAGS).toBe(5);
  });

  it("keeps the §6 final-count invariant MIN_NONZERO_FLOOR ≤ LOWER_FLOOR", () => {
    expect(FINAL_COUNT.MIN_NONZERO_FLOOR).toBeLessThanOrEqual(
      FINAL_COUNT.LOWER_FLOOR,
    );
    expect(FINAL_COUNT).toMatchObject({
      LOWER_FLOOR: 20,
      scale: 30,
      MIN_NONZERO_FLOOR: 1,
    });
  });

  it("ships empty membership lists until PR 2 populates them", () => {
    // PR 1 deliberately keeps both lists empty; PR 2 wires them under
    // ops sign-off and bumps `baseline_version`. Until then, no
    // selector / slot allocator should read these.
    expect(CRITICAL_CATEGORIES.size).toBe(0);
    expect(FAVORED_BUCKETS.size).toBe(0);
  });
});
