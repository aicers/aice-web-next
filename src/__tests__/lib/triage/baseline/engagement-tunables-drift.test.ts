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
 * The "snapshot agreement" check in RFC §9.3 — "every key in
 * `ENGAGEMENT_TUNABLES` matches the active `engagement_model_snapshot`
 * row" — is also exercised here: the `ensureEngagementModelSnapshot`
 * upsert is invoked against a recording fake pool and its JSON
 * `formula` / `window_bounds` payload plus its `aggregate_sql_digest`
 * are asserted to match the inlined tunables and the canonical §7
 * aggregate SQL. The integration test suite still proves the row
 * actually lands in the DB at deploy time; this test pins the
 * code-side payload so a payload drift fails on the unit harness,
 * not in production.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _inlinedConstants } from "@/lib/triage/baseline/compose.mjs";
import { ENGAGEMENT_TUNABLES } from "@/lib/triage/baseline/engagement-tunables";
import { ENGAGEMENT_AGGREGATE_SQL } from "@/lib/triage/engagement/aggregate";
import {
  _resetEngagementSnapshotSeedCache,
  ensureEngagementModelSnapshot,
} from "@/lib/triage/engagement/snapshot";

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

describe("engagement-tunables ↔ engagement_model_snapshot agreement", () => {
  afterEach(() => {
    _resetEngagementSnapshotSeedCache();
  });

  it("ensureEngagementModelSnapshot upsert payload matches the inlined tunables", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const fakePool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1 };
      }),
    } as unknown as Parameters<typeof ensureEngagementModelSnapshot>[0];

    await ensureEngagementModelSnapshot(fakePool);
    expect(queries).toHaveLength(1);
    const call = queries[0];
    expect(call.sql).toMatch(/INSERT INTO engagement_model_snapshot/);
    expect(call.sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/);

    const params = call.params as unknown[];
    expect(params).toHaveLength(4);
    expect(params[0]).toBe(ENGAGEMENT_TUNABLES.engagementModelVersion);

    const formula = JSON.parse(params[1] as string) as Record<string, unknown>;
    expect(formula).toEqual({
      gamma: ENGAGEMENT_TUNABLES.gamma,
      per_bucket_min_impressions: ENGAGEMENT_TUNABLES.perBucketMinImpressions,
      ewma_half_life_window_ratio: ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio,
      exploration_share: ENGAGEMENT_TUNABLES.explorationShare,
      tenant_cold_start_min_impressions:
        ENGAGEMENT_TUNABLES.tenantColdStartMinImpressions,
      engaged_actions: [...ENGAGEMENT_TUNABLES.engagedActions],
      included_shown_by: [...ENGAGEMENT_TUNABLES.includedShownBy],
    });

    const windowBounds = JSON.parse(params[2] as string) as Record<
      string,
      unknown
    >;
    expect(windowBounds).toEqual({
      active_windows_days: [...ENGAGEMENT_TUNABLES.activeWindowsDays],
      half_life_window_ratio: ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio,
      selection_rule: "longest_window_with_min_impressions",
    });

    // Digest is SHA-256 over the canonical §7 aggregate SQL — it
    // changes only when the aggregate shape changes, which is
    // exactly when `engagement_model_version` must bump.
    const expectedDigest = createHash("sha256")
      .update(ENGAGEMENT_AGGREGATE_SQL)
      .digest("hex");
    expect(params[3]).toBe(expectedDigest);
  });
});
