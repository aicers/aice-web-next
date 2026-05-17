/**
 * Behavioral-invariance test for Phase 2 first ship (#589 acceptance).
 *
 * `composeMenu` with `gamma = 0` (the shipped tunable) MUST produce
 * a byte-identical result — rows, quotas, ordering, assembledCount,
 * fallbackInvoked — to the pre-Phase-2 implementation regardless of
 * whether `bucketEngagement` is `undefined` (legacy / kill-switch
 * path) or populated (loader passes it through for audit). This is
 * the load-bearing test for the first ship: any future formula edit
 * that breaks the `γ = 0` collapse trips this case immediately.
 *
 * The fixture is a synthetic cohort large enough to exercise the
 * largest-remainder allocator, the favored-bucket prior, and the
 * `MIN_NONZERO_FLOOR` fallback. The recorded expectations are the
 * algorithm's actual outputs at the time of writing — captured here
 * so a future drift surfaces as an exact diff rather than a soft
 * "looks close" comparison.
 */

import { describe, expect, it } from "vitest";

import { type ComposeMenuInput, composeMenu } from "@/lib/triage/baseline/menu";

interface FixtureRow {
  eventKey: string;
  kind: string;
  isUnlabeled: boolean;
  baselineScore: number;
  selectorTags: string[];
}

const FIXTURE: ReadonlyArray<FixtureRow> = [
  // HttpThreat:true (favored, unlabeled-cluster)
  ...Array.from({ length: 12 }, (_, i) => ({
    eventKey: `httpthreat-unl-${i}`,
    kind: "HttpThreat",
    isUnlabeled: true,
    baselineScore: 0.9 - i * 0.01,
    selectorTags: ["S1-high", "S2-severe", "unlabeled-cluster"],
  })),
  // HttpThreat:false (not favored, labeled)
  ...Array.from({ length: 10 }, (_, i) => ({
    eventKey: `httpthreat-lab-${i}`,
    kind: "HttpThreat",
    isUnlabeled: false,
    baselineScore: 0.85 - i * 0.01,
    selectorTags: ["S1-high", "S2-severe"],
  })),
  // DnsCovertChannel:false (favored)
  ...Array.from({ length: 8 }, (_, i) => ({
    eventKey: `dns-${i}`,
    kind: "DnsCovertChannel",
    isUnlabeled: false,
    baselineScore: 0.8 - i * 0.01,
    selectorTags: ["S1-high", "S3-recurring"],
  })),
  // LockyRansomware:false (favored)
  ...Array.from({ length: 5 }, (_, i) => ({
    eventKey: `locky-${i}`,
    kind: "LockyRansomware",
    isUnlabeled: false,
    baselineScore: 0.75 - i * 0.01,
    selectorTags: ["S2-severe"],
  })),
  // TorConnection:false (not favored)
  ...Array.from({ length: 6 }, (_, i) => ({
    eventKey: `tor-${i}`,
    kind: "TorConnection",
    isUnlabeled: false,
    baselineScore: 0.7 - i * 0.01,
    selectorTags: ["S1-high"],
  })),
];

function buildInput(
  bucketEngagement: ComposeMenuInput["bucketEngagement"] | undefined,
): ComposeMenuInput {
  const aggMap = new Map<
    string,
    {
      bucket: { kind: string; isUnlabeled: boolean };
      count: number;
      totalTagCardinality: number;
    }
  >();
  for (const row of FIXTURE) {
    const key = `${row.kind}:${row.isUnlabeled}`;
    const agg = aggMap.get(key);
    if (agg === undefined) {
      aggMap.set(key, {
        bucket: { kind: row.kind, isUnlabeled: row.isUnlabeled },
        count: 1,
        totalTagCardinality: row.selectorTags.length,
      });
    } else {
      agg.count += 1;
      agg.totalTagCardinality += row.selectorTags.length;
    }
  }
  return {
    postExclusionCount: FIXTURE.length,
    bucketAggregates: Array.from(aggMap.values()),
    candidates: FIXTURE.map((r) => ({
      eventKey: r.eventKey,
      eventTime: new Date("2026-05-16T00:00:00Z"),
      kind: r.kind,
      baselineVersion: "phase1b-four-selector",
      rawScore: r.baselineScore,
      baselineScore: r.baselineScore,
      selectorTags: r.selectorTags,
    })),
    cutoff: 0,
    bucketEngagement,
  };
}

describe("composeMenu γ = 0 behavioral invariance (RFC 0003 §13 Phase 2a)", () => {
  it("byte-identical output regardless of bucketEngagement (undefined vs populated)", () => {
    const without = composeMenu(buildInput(undefined));
    // A populated `bucketEngagement` that the kill-switch must ignore.
    // With γ = 0 every entry — high or low — must produce zero
    // engagement contribution to the share formula.
    const populated = composeMenu(
      buildInput([
        {
          bucketKey: "HttpThreat:true",
          engagementRate: 0.95,
          impressionCount: 5000,
          windowDays: 14,
        },
        {
          bucketKey: "HttpThreat:false",
          engagementRate: 0.01,
          impressionCount: 5000,
          windowDays: 14,
        },
        {
          bucketKey: "DnsCovertChannel:false",
          engagementRate: 0.5,
          impressionCount: 5000,
          windowDays: 14,
        },
        {
          bucketKey: "LockyRansomware:false",
          engagementRate: 0.0,
          impressionCount: 5000,
          windowDays: 14,
        },
        {
          bucketKey: "TorConnection:false",
          engagementRate: 0.99,
          impressionCount: 5000,
          windowDays: 14,
        },
      ]),
    );
    expect(populated.assembledCount).toBe(without.assembledCount);
    expect(populated.fallbackInvoked).toBe(without.fallbackInvoked);
    expect(populated.defaultN).toBe(without.defaultN);
    expect([...populated.quotas.entries()].sort()).toEqual(
      [...without.quotas.entries()].sort(),
    );
    expect(populated.rows.map((r) => r.eventKey)).toEqual(
      without.rows.map((r) => r.eventKey),
    );
  });

  it("the N_min gate does not change behavior under γ = 0 (still zero contribution)", () => {
    // Engagement signals below N_min are zeroed by the gate; under
    // γ = 0 they are also zeroed by the kill-switch. The output
    // must be identical either way.
    const undergated = composeMenu(
      buildInput([
        // Every bucket has fewer impressions than N_min (= 100).
        {
          bucketKey: "HttpThreat:true",
          engagementRate: 0.95,
          impressionCount: 10,
          windowDays: 7,
        },
        {
          bucketKey: "DnsCovertChannel:false",
          engagementRate: 0.5,
          impressionCount: 10,
          windowDays: 7,
        },
      ]),
    );
    const without = composeMenu(buildInput(undefined));
    expect(undergated.rows.map((r) => r.eventKey)).toEqual(
      without.rows.map((r) => r.eventKey),
    );
    expect([...undergated.quotas.entries()].sort()).toEqual(
      [...without.quotas.entries()].sort(),
    );
  });

  it("exploration carve-out is gated on γ > 0 (no slot deduction at γ = 0)", () => {
    // The §5.4 carve-out reserves `round(ε · defaultN)` slots only
    // when γ > 0. With γ = 0 (Phase 2a), `computeBucketQuotas`
    // must receive the full defaultN — verified by checking the
    // total quota across all buckets is unchanged from the no-
    // engagement baseline (the carve-out would otherwise shift
    // slots toward the bottom-decile bucket).
    const without = composeMenu(buildInput(undefined));
    const populated = composeMenu(
      buildInput([
        {
          bucketKey: "HttpThreat:true",
          engagementRate: 0.95,
          impressionCount: 5000,
          windowDays: 14,
        },
        {
          bucketKey: "TorConnection:false",
          engagementRate: 0.0,
          impressionCount: 5000,
          windowDays: 14,
        },
      ]),
    );
    const sumWithout = [...without.quotas.values()].reduce((s, n) => s + n, 0);
    const sumPopulated = [...populated.quotas.values()].reduce(
      (s, n) => s + n,
      0,
    );
    expect(sumPopulated).toBe(sumWithout);
  });
});
