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
  SELECTOR_TAGS,
  SELECTOR_WEIGHTS,
  SLOT_ALLOCATION,
  STATISTICS_WINDOW_DAYS,
  TAG_THRESHOLDS,
} from "@/lib/triage/baseline/tunables";

describe("§9 tunables (PR 2 / #513)", () => {
  it("freezes the Phase 1.B baseline-version marker", () => {
    // The read path partitions `cume_dist()` cohorts by
    // `(kind, baseline_version)`, so bumping this value is a corpus
    // re-partition — RFC 0001 §10 requires a deliberate version bump,
    // never a drive-by edit here.
    expect(PHASE_1B_BASELINE_VERSION).toBe("phase1b-four-selector");
  });

  it("exposes the calibrated §9 selector weights from the RFC", () => {
    expect(SELECTOR_WEIGHTS).toEqual({
      w_S1: 1.0,
      w_S2: 1.5,
      w_S3: 0.8,
      w_S4: 0.8,
      w_UNLABELED: 0.5,
    });
  });

  it("exposes the calibrated §9 saturation caps", () => {
    expect(SELECTOR_SATURATION).toEqual({ R: 10, C: 4 });
  });

  it("exposes the calibrated §4 slot-allocation tunables", () => {
    expect(SLOT_ALLOCATION).toEqual({
      base_share: 0.02,
      alpha: 1.0,
      beta: 0.1,
    });
  });

  it("ships the five §9 selector tag names matching MAX_TAGS", () => {
    expect(MAX_TAGS).toBe(5);
    expect(Object.values(SELECTOR_TAGS)).toEqual([
      "S1-high",
      "S2-severe",
      "S3-recurring",
      "S4-correlated",
      "unlabeled-cluster",
    ]);
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

  it("exposes the §9 per-event tag thresholds", () => {
    expect(TAG_THRESHOLDS).toEqual({
      s1_high: 0.85,
      s3_recurring: 0.5,
      s4_correlated: 0.5,
    });
  });

  it("declares the §7 statistics windows in ascending order", () => {
    expect(STATISTICS_WINDOW_DAYS).toEqual([7, 14, 30]);
  });

  it("populates the §3 CRITICAL_CATEGORIES set anchored on Phase 1.A's whitelist", () => {
    expect(CRITICAL_CATEGORIES.has("COMMAND_AND_CONTROL")).toBe(true);
    expect(CRITICAL_CATEGORIES.has("CREDENTIAL_ACCESS")).toBe(true);
    expect(CRITICAL_CATEGORIES.has("EXFILTRATION")).toBe(true);
    expect(CRITICAL_CATEGORIES.has("IMPACT")).toBe(true);
    expect(CRITICAL_CATEGORIES.has("INITIAL_ACCESS")).toBe(true);
    expect(CRITICAL_CATEGORIES.has("RECONNAISSANCE")).toBe(false);
    expect(CRITICAL_CATEGORIES.size).toBe(5);
  });

  it("populates §5 FAVORED_BUCKETS with the five empirically-useful kinds", () => {
    expect(FAVORED_BUCKETS.has("DnsCovertChannel:false")).toBe(true);
    expect(FAVORED_BUCKETS.has("HttpThreat:true")).toBe(true);
    expect(FAVORED_BUCKETS.has("LockyRansomware:false")).toBe(true);
    expect(FAVORED_BUCKETS.has("RepeatedHttpSessions:false")).toBe(true);
    expect(FAVORED_BUCKETS.has("SuspiciousTlsTraffic:false")).toBe(true);
    // Labeled HttpThreat is NOT favored — the bucket form distinguishes
    // it from the unlabeled-HttpThreat virtual kind (RFC §4).
    expect(FAVORED_BUCKETS.has("HttpThreat:false")).toBe(false);
    expect(FAVORED_BUCKETS.size).toBe(5);
  });
});
