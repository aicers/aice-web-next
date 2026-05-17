/**
 * Drift guard for the Phase 2 engagement tunables (RFC 0003 §9.3).
 *
 * `compose.mjs` is plain ESM and cannot import from
 * `engagement-tunables.ts` because the measurement harness loads it
 * from plain Node. The tunables are inlined inside `compose.mjs` and
 * this test asserts they still match the canonical TS source — a
 * future Phase 2b retune must update both copies, and this test will
 * fail loudly until they do.
 *
 * The "snapshot agreement" check in RFC §9.3 ("every key in
 * `ENGAGEMENT_TUNABLES` matches the active `engagement_model_snapshot`
 * row") cannot be exercised in unit tests without a tenant DB — that
 * assertion runs in the integration test suite at deploy time. The
 * code-side half lives here.
 */

import { describe, expect, it } from "vitest";

import { _inlinedConstants } from "@/lib/triage/baseline/compose.mjs";
import { ENGAGEMENT_TUNABLES } from "@/lib/triage/baseline/engagement-tunables";

describe("engagement-tunables drift guard", () => {
  it("scalar values match the inlined copy in compose.mjs", () => {
    const inlined = _inlinedConstants.ENGAGEMENT_TUNABLES;
    expect(inlined.gamma).toBe(ENGAGEMENT_TUNABLES.gamma);
    expect(inlined.perBucketMinImpressions).toBe(
      ENGAGEMENT_TUNABLES.perBucketMinImpressions,
    );
    expect(inlined.ewmaHalfLifeWindowRatio).toBe(
      ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio,
    );
    expect(inlined.explorationShare).toBe(ENGAGEMENT_TUNABLES.explorationShare);
    expect(inlined.tenantColdStartMinImpressions).toBe(
      ENGAGEMENT_TUNABLES.tenantColdStartMinImpressions,
    );
    expect(inlined.engagementModelVersion).toBe(
      ENGAGEMENT_TUNABLES.engagementModelVersion,
    );
  });

  it("array values match the inlined copy in compose.mjs", () => {
    const inlined = _inlinedConstants.ENGAGEMENT_TUNABLES;
    expect([...inlined.includedShownBy]).toEqual([
      ...ENGAGEMENT_TUNABLES.includedShownBy,
    ]);
    expect([...inlined.engagedActions]).toEqual([
      ...ENGAGEMENT_TUNABLES.engagedActions,
    ]);
    expect([...inlined.activeWindowsDays]).toEqual([
      ...ENGAGEMENT_TUNABLES.activeWindowsDays,
    ]);
  });

  it("Phase 2a first-ship kill-switch invariant: gamma = 0", () => {
    // Documented invariant — the calibration retune (Phase 2b)
    // flips this through a code change in the same PR as the
    // `baseline_version` bump (amended RFC §13). Until then the
    // engagement term is inert and menu output is byte-identical to
    // RFC 0001.
    expect(ENGAGEMENT_TUNABLES.gamma).toBe(0);
  });
});
