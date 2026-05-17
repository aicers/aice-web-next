/**
 * Direct coverage for RFC 0003 §5.4 exploration carve-out — the
 * production-shipped code path that is dormant under Phase 2a
 * (`γ = 0`) but activates under Phase 2b (`γ > 0`). The Phase 2a
 * invariance test in `compose-engagement-invariance.test.ts` only
 * proves the kill-switch path; this file pins the §5.4 contract so a
 * future formula edit that breaks the carve-out trips before Phase 2b
 * calibration lands, not after.
 *
 * The carve-out runs entirely inside `composeMenu`; production never
 * passes γ from the outside (it reads `ENGAGEMENT_TUNABLES.gamma`).
 * The internal helper is exposed via `_testing` for this test only.
 */

import { describe, expect, it } from "vitest";

import type { BucketAggregate } from "@/lib/triage/baseline/compose.d.mts";
import { _testing } from "@/lib/triage/baseline/menu";

const { computeBucketQuotasWithExploration } = _testing;

const HIGH = { kind: "HttpThreat", isUnlabeled: true };
const MID_A = { kind: "DnsCovertChannel", isUnlabeled: false };
const MID_B = { kind: "LockyRansomware", isUnlabeled: false };
const LOW = { kind: "TorConnection", isUnlabeled: false };

const FOUR_BUCKETS: ReadonlyArray<BucketAggregate> = [
  { bucket: HIGH, count: 40, totalTagCardinality: 120 },
  { bucket: MID_A, count: 30, totalTagCardinality: 60 },
  { bucket: MID_B, count: 20, totalTagCardinality: 40 },
  { bucket: LOW, count: 10, totalTagCardinality: 10 },
];

function signalMap(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe("computeBucketQuotasWithExploration (RFC 0003 §5.4)", () => {
  it("γ = 0 short-circuits — no carve-out, full defaultN flows to primary allocation", () => {
    const signals = signalMap({
      "HttpThreat:true": 0.9,
      "DnsCovertChannel:false": 0.5,
      "LockyRansomware:false": 0.5,
      "TorConnection:false": 0.05,
    });
    const quotas = computeBucketQuotasWithExploration(
      FOUR_BUCKETS,
      100,
      signals,
      0,
      0.1,
    );
    const total = [...quotas.values()].reduce((s, n) => s + n, 0);
    expect(total).toBe(100);
  });

  it("explorationShare = 0 short-circuits even when γ > 0", () => {
    const signals = signalMap({
      "HttpThreat:true": 0.9,
      "TorConnection:false": 0.05,
    });
    const quotas = computeBucketQuotasWithExploration(
      FOUR_BUCKETS,
      100,
      signals,
      0.2,
      0,
    );
    const total = [...quotas.values()].reduce((s, n) => s + n, 0);
    expect(total).toBe(100);
  });

  it("γ > 0 reserves round(ε · defaultN) carve-out slots for the lowest-signal bucket", () => {
    // 4 buckets ⇒ decileSize = ceil(4/10) = 1 ⇒ all carve-out lands
    // on the single lowest-signal bucket (TorConnection:false).
    const signals = signalMap({
      "HttpThreat:true": 0.9,
      "DnsCovertChannel:false": 0.5,
      "LockyRansomware:false": 0.5,
      "TorConnection:false": 0.05,
    });
    const epsilon = 0.1;
    const defaultN = 100;
    const withCarveout = computeBucketQuotasWithExploration(
      FOUR_BUCKETS,
      defaultN,
      signals,
      0.2,
      epsilon,
    );
    const withoutCarveout = computeBucketQuotasWithExploration(
      FOUR_BUCKETS,
      defaultN,
      signals,
      0.2,
      0,
    );

    // Total preserved — carve-out moves slots, never invents them.
    const sumWith = [...withCarveout.values()].reduce((s, n) => s + n, 0);
    const sumWithout = [...withoutCarveout.values()].reduce((s, n) => s + n, 0);
    expect(sumWith).toBe(defaultN);
    expect(sumWithout).toBe(defaultN);

    // The lowest-signal bucket strictly gains slots from the carve-out:
    // it gets the round(ε·defaultN) reserve on top of whatever the
    // (1−ε)·defaultN primary allocation gave it.
    const lowKey = "TorConnection:false";
    expect(withCarveout.get(lowKey) ?? 0).toBeGreaterThan(
      withoutCarveout.get(lowKey) ?? 0,
    );
  });

  it("carve-out tie-breaks ascending-signal-first across the bottom decile", () => {
    // 11 buckets ⇒ decileSize = ceil(11/10) = 2 ⇒ carve-out is split
    // across the two lowest-signal buckets. With an odd ε·defaultN
    // (e.g. round(0.1·25) = 3) the remainder lands on the deepest
    // under-engaged bucket first per the §5.4 ordering note.
    const buckets: BucketAggregate[] = Array.from({ length: 11 }, (_, i) => ({
      bucket: { kind: `Kind${i}`, isUnlabeled: false },
      count: 10 + i,
      totalTagCardinality: 10,
    }));
    const signals = new Map<string, number>();
    for (let i = 0; i < 11; i++) {
      signals.set(`Kind${i}:false`, i * 0.05);
    }

    const quotas = computeBucketQuotasWithExploration(
      buckets,
      25,
      signals,
      0.2,
      0.1,
    );
    const total = [...quotas.values()].reduce((s, n) => s + n, 0);
    expect(total).toBe(25);

    // Deepest under-engaged bucket (`Kind0`) receives at least one
    // carve-out slot AND, with the odd-remainder rule, no less than
    // its sibling in the decile (`Kind1`).
    const k0 = quotas.get("Kind0:false") ?? 0;
    const k1 = quotas.get("Kind1:false") ?? 0;
    expect(k0).toBeGreaterThanOrEqual(k1);
  });

  it("empty aggregates / defaultN = 0 returns empty quotas without throwing", () => {
    const empty = computeBucketQuotasWithExploration(
      [],
      100,
      new Map(),
      0.2,
      0.1,
    );
    expect(empty.size).toBe(0);

    const zero = computeBucketQuotasWithExploration(
      FOUR_BUCKETS,
      0,
      new Map(),
      0.2,
      0.1,
    );
    expect(zero.size).toBe(0);
  });
});
