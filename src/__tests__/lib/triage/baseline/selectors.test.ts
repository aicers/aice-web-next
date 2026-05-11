import { describe, expect, it, vi } from "vitest";

import {
  type ActiveWindows,
  buildSelectorOutputs,
  detectActiveWindows,
  emitSelectorTags,
  type PageScoringRow,
  type PerWindowValues,
  scoreSelectorsForPage,
} from "@/lib/triage/baseline/selectors";

const ALL_WINDOWS: ActiveWindows = new Set([7, 14, 30] as const);

function makeRow(overrides: Partial<PageScoringRow> = {}): PageScoringRow {
  return {
    eventKey: "1",
    kind: "HttpThreat",
    origAddr: "10.0.0.1",
    respAddr: "1.1.1.1",
    category: "COMMAND_AND_CONTROL",
    confidence: 0.5,
    clusterId: "real-cluster",
    ...overrides,
  };
}

function makePerWindow(
  overrides: Partial<PerWindowValues> = {},
): PerWindowValues {
  return {
    s1: { 7: 0, 14: 0, 30: 0, ...(overrides.s1 ?? {}) },
    s3RepeatMinusSelf: {
      7: 0,
      14: 0,
      30: 0,
      ...(overrides.s3RepeatMinusSelf ?? {}),
    },
    s4DistinctMinusSelf: {
      7: 0,
      14: 0,
      30: 0,
      ...(overrides.s4DistinctMinusSelf ?? {}),
    },
  };
}

describe("emitSelectorTags — §9 tag thresholds", () => {
  it("emits S1-high above the 0.85 threshold and not at or below", () => {
    expect(emitSelectorTags(0.86, 0, 0, 0, 0)).toContain("S1-high");
    expect(emitSelectorTags(0.85, 0, 0, 0, 0)).not.toContain("S1-high");
    expect(emitSelectorTags(0.5, 0, 0, 0, 0)).not.toContain("S1-high");
  });

  it("emits S3-recurring and S4-correlated above 0.5", () => {
    expect(emitSelectorTags(0, 0, 0.6, 0.6, 0)).toEqual(
      expect.arrayContaining(["S3-recurring", "S4-correlated"]),
    );
    expect(emitSelectorTags(0, 0, 0.5, 0.5, 0)).toEqual([]);
  });

  it("emits S2-severe and unlabeled-cluster only on the binary fire", () => {
    expect(emitSelectorTags(0, 1, 0, 0, 0)).toEqual(["S2-severe"]);
    expect(emitSelectorTags(0, 0, 0, 0, 1)).toEqual(["unlabeled-cluster"]);
    expect(emitSelectorTags(0, 0, 0, 0, 0)).toEqual([]);
  });

  it("emits the full five-tag set when every selector fires", () => {
    expect(emitSelectorTags(1.0, 1, 1.0, 1.0, 1)).toEqual([
      "S1-high",
      "S2-severe",
      "S3-recurring",
      "S4-correlated",
      "unlabeled-cluster",
    ]);
  });
});

describe("buildSelectorOutputs — §3 weighted sum + §7 per-window MAX", () => {
  it("combines per-window MAX for S1 / S3 / S4 across active windows", () => {
    // S3 is higher in the 7d window than 30d → MAX picks 7d.
    const perWindow = makePerWindow({
      s1: { 7: 0.1, 14: 0.5, 30: 0.2 },
      s3RepeatMinusSelf: { 7: 8, 14: 4, 30: 4 },
      s4DistinctMinusSelf: { 7: 1, 14: 2, 30: 3 },
    });
    const out = buildSelectorOutputs(
      makeRow({ category: null, clusterId: "real-cluster" }),
      perWindow,
      ALL_WINDOWS,
    );
    // s1 = max(0.1, 0.5, 0.2) = 0.5
    expect(out.s1).toBe(0.5);
    // s3 = min(1, max(8, 4, 4) / R=10) = 0.8
    expect(out.s3).toBeCloseTo(0.8, 10);
    // s4 = min(1, max(1, 2, 3) / C=4) = 0.75
    expect(out.s4).toBeCloseTo(0.75, 10);
    expect(out.s2).toBe(0);
    expect(out.unlabeled).toBe(0);
  });

  it("zeroes pre-activation windows so they do not depress the MAX", () => {
    const perWindow = makePerWindow({
      s3RepeatMinusSelf: { 7: 9, 14: 9, 30: 9 },
    });
    // Only 7d active; the 14d / 30d values do not exist in the corpus
    // yet, but the SQL is allowed to return per-window numerators
    // anyway (the planner does not know about activation). The active-
    // windows filter is what makes the RFC's "pre-activation contributes
    // 0" guarantee load-bearing.
    const onlySeven: ActiveWindows = new Set([7] as const);
    const out = buildSelectorOutputs(makeRow(), perWindow, onlySeven);
    // Even with 9 in every window, only 7d contributes → still 0.9.
    expect(out.s3).toBeCloseTo(0.9, 10);
  });

  it("collapses every selector to 0 when no windows are active (cold start day 1)", () => {
    const perWindow = makePerWindow({
      s1: { 7: 0.95, 14: 0.95, 30: 0.95 },
      s3RepeatMinusSelf: { 7: 100, 14: 100, 30: 100 },
      s4DistinctMinusSelf: { 7: 100, 14: 100, 30: 100 },
    });
    const out = buildSelectorOutputs(
      makeRow({ category: null, clusterId: "real-cluster" }),
      perWindow,
      new Set(),
    );
    expect(out.s1).toBe(0);
    expect(out.s3).toBe(0);
    expect(out.s4).toBe(0);
    // S2 and UNLABELED_BONUS are per-event, not windowed.
    expect(out.rawScore).toBe(0);
  });

  it("forces S3 = 0 and S4 = 0 when orig_addr IS NULL (RFC §3 NULL contract)", () => {
    const perWindow = makePerWindow({
      s3RepeatMinusSelf: { 7: 50, 14: 50, 30: 50 },
      s4DistinctMinusSelf: { 7: 50, 14: 50, 30: 50 },
    });
    const out = buildSelectorOutputs(
      makeRow({ origAddr: null, respAddr: "1.1.1.1" }),
      perWindow,
      ALL_WINDOWS,
    );
    expect(out.s3).toBe(0);
    expect(out.s4).toBe(0);
  });

  it("forces S3 = 0 but not S4 when only resp_addr IS NULL (RFC §3 NULL contract)", () => {
    const perWindow = makePerWindow({
      s3RepeatMinusSelf: { 7: 50, 14: 50, 30: 50 },
      s4DistinctMinusSelf: { 7: 2, 14: 2, 30: 2 },
    });
    const out = buildSelectorOutputs(
      makeRow({ origAddr: "10.0.0.1", respAddr: null }),
      perWindow,
      ALL_WINDOWS,
    );
    expect(out.s3).toBe(0);
    // s4 with C=4 should still produce a normal value (2/4 = 0.5).
    expect(out.s4).toBeCloseTo(0.5, 10);
  });

  it("fires S2-severe only for categories in CRITICAL_CATEGORIES", () => {
    const out = buildSelectorOutputs(
      makeRow({ category: "IMPACT" }),
      makePerWindow(),
      ALL_WINDOWS,
    );
    expect(out.s2).toBe(1);
    expect(out.selectorTags).toContain("S2-severe");

    const reconOut = buildSelectorOutputs(
      makeRow({ category: "RECONNAISSANCE" }),
      makePerWindow(),
      ALL_WINDOWS,
    );
    expect(reconOut.s2).toBe(0);
    expect(reconOut.selectorTags).not.toContain("S2-severe");
  });

  it("falls through to s2 = 0 when category IS NULL", () => {
    const out = buildSelectorOutputs(
      makeRow({ category: null }),
      makePerWindow(),
      ALL_WINDOWS,
    );
    expect(out.s2).toBe(0);
  });

  it("fires unlabeled-cluster only on HttpThreat with isClusterNone", () => {
    expect(
      buildSelectorOutputs(
        makeRow({ kind: "HttpThreat", clusterId: "" }),
        makePerWindow(),
        ALL_WINDOWS,
      ).unlabeled,
    ).toBe(1);
    expect(
      buildSelectorOutputs(
        makeRow({ kind: "HttpThreat", clusterId: "none" }),
        makePerWindow(),
        ALL_WINDOWS,
      ).unlabeled,
    ).toBe(1);
    expect(
      buildSelectorOutputs(
        makeRow({ kind: "HttpThreat", clusterId: "real-cluster" }),
        makePerWindow(),
        ALL_WINDOWS,
      ).unlabeled,
    ).toBe(0);
    // Non-HttpThreat kinds never fire UNLABELED_BONUS regardless of
    // clusterId presence.
    expect(
      buildSelectorOutputs(
        makeRow({ kind: "DnsCovertChannel", clusterId: "none" }),
        makePerWindow(),
        ALL_WINDOWS,
      ).unlabeled,
    ).toBe(0);
  });

  it("computes raw_score as the §3 weighted sum", () => {
    const perWindow = makePerWindow({
      s1: { 7: 0.9, 14: 0.5, 30: 0.5 },
      s3RepeatMinusSelf: { 7: 5, 14: 5, 30: 5 },
      s4DistinctMinusSelf: { 7: 2, 14: 2, 30: 2 },
    });
    const out = buildSelectorOutputs(
      makeRow({ category: "IMPACT", kind: "HttpThreat", clusterId: "" }),
      perWindow,
      ALL_WINDOWS,
    );
    // s1 = 0.9, s2 = 1, s3 = 0.5, s4 = 0.5, unlabeled = 1
    // raw = 1.0·0.9 + 1.5·1 + 0.8·0.5 + 0.8·0.5 + 0.5·1
    //     = 0.9 + 1.5 + 0.4 + 0.4 + 0.5 = 3.7
    expect(out.rawScore).toBeCloseTo(3.7, 10);
  });
});

describe("scoreSelectorsForPage — batched SELECT shape", () => {
  it("returns an empty map when the page has no rows (no DB round-trip)", async () => {
    const client = { query: vi.fn() };
    const result = await scoreSelectorsForPage(
      client as unknown as Parameters<typeof scoreSelectorsForPage>[0],
      [],
    );
    expect(result.size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("issues exactly one query packing all three windows + selectors", async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          {
            event_key: "1001",
            s1_7d: 0.9,
            s1_14d: 0.5,
            s1_30d: 0.5,
            s3_7d: "11", // bigint serialized as string by pg
            s3_14d: "5",
            s3_30d: "5",
            s4_7d: "3",
            s4_14d: "2",
            s4_30d: "2",
          },
        ],
        rowCount: 1,
      })),
    };
    const rows: PageScoringRow[] = [
      {
        eventKey: "1001",
        kind: "HttpThreat",
        origAddr: "10.0.0.1",
        respAddr: "1.1.1.1",
        category: "IMPACT",
        confidence: 0.7,
        clusterId: "",
      },
    ];
    const result = await scoreSelectorsForPage(
      client as unknown as Parameters<typeof scoreSelectorsForPage>[0],
      rows,
    );
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    // Single SELECT carrying the three CTE windows for S1, the per-
    // window FILTER aggregates for S3 / S4, and the final joined
    // projection.
    expect(sql).toMatch(/ranked_7d/);
    expect(sql).toMatch(/ranked_14d/);
    expect(sql).toMatch(/ranked_30d/);
    expect(sql).toMatch(/FILTER \(WHERE o\.event_time/);
    // S1 ranks within the page's kinds only — the planner must not
    // partition over the tenant-wide kind set.
    expect(sql).toMatch(/page_kinds/);
    expect(sql).toMatch(/kind IN \(SELECT kind FROM page_kinds\)/);
    // S1 excludes NULL confidence from the ranked population (PG sorts
    // NULLs LAST in ASC, so leaving them in would give NULL-confidence
    // rows `cume_dist() = 1.0` and falsely emit `S1-high`).
    expect(sql).toMatch(/confidence IS NOT NULL/);
    // S3 / S4 use the "aggregate once, join back" shape — corpus rows
    // group per (kind, orig[, resp]) tuple once, page rows then join
    // the aggregate. Avoids re-grouping the 30d corpus per page row.
    expect(sql).toMatch(/s3_aggr/);
    expect(sql).toMatch(/s4_aggr/);
    expect(sql).toMatch(/page_s3_keys/);
    expect(sql).toMatch(/page_s4_keys/);
    // Page-row tuple binds four params per row (event_key, kind,
    // orig_addr, resp_addr).
    expect(params).toHaveLength(4);
    expect(params).toEqual(["1001", "HttpThreat", "10.0.0.1", "1.1.1.1"]);

    const out = result.get("1001");
    expect(out).toBeDefined();
    // -1 self-exclusion is applied in JS, so s3_7d 11 → repeat-minus-self 10.
    expect(out?.s3RepeatMinusSelf[7]).toBe(10);
    expect(out?.s3RepeatMinusSelf[14]).toBe(4);
    // s4_7d 3 → distinct-minus-self 2.
    expect(out?.s4DistinctMinusSelf[7]).toBe(2);
    expect(out?.s1[7]).toBeCloseTo(0.9, 10);
  });

  it("clamps -1 self-exclusion at 0 so a row whose count came back 0 does not produce a negative numerator", async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          {
            event_key: "1",
            s1_7d: 0,
            s1_14d: 0,
            s1_30d: 0,
            s3_7d: "0",
            s3_14d: "0",
            s3_30d: "0",
            s4_7d: "0",
            s4_14d: "0",
            s4_30d: "0",
          },
        ],
        rowCount: 1,
      })),
    };
    const result = await scoreSelectorsForPage(
      client as unknown as Parameters<typeof scoreSelectorsForPage>[0],
      [
        {
          eventKey: "1",
          kind: "PortScan",
          origAddr: null,
          respAddr: null,
          category: null,
          confidence: null,
          clusterId: null,
        },
      ],
    );
    const out = result.get("1");
    expect(out?.s3RepeatMinusSelf[7]).toBe(0);
    expect(out?.s4DistinctMinusSelf[7]).toBe(0);
  });
});

describe("detectActiveWindows — §7 cold start", () => {
  it("returns empty set when corpus_activated_at is NULL (fresh deploy)", async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [{ corpus_activated_at: null }],
        rowCount: 1,
      })),
    };
    const active = await detectActiveWindows(
      client as unknown as Parameters<typeof detectActiveWindows>[0],
    );
    expect(active.size).toBe(0);
    const [sql] = (client.query.mock.calls[0] ?? []) as unknown as [string];
    // Anchors on the corpus-state singleton, not on observed_event_meta
    // event_time — historical catch-up rows must not activate windows
    // whose corpus is still partial.
    expect(sql).toMatch(/corpus_activated_at/);
    expect(sql).toMatch(/baseline_corpus_state/);
    expect(sql).not.toMatch(/observed_event_meta/);
  });

  it("returns empty set when the singleton row is missing", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const active = await detectActiveWindows(
      client as unknown as Parameters<typeof detectActiveWindows>[0],
    );
    expect(active.size).toBe(0);
  });

  it("returns {7} when the corpus was activated 8 days ago", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const client = {
      query: vi.fn(async () => ({
        rows: [{ corpus_activated_at: eightDaysAgo }],
        rowCount: 1,
      })),
    };
    const active = await detectActiveWindows(
      client as unknown as Parameters<typeof detectActiveWindows>[0],
    );
    expect([...active]).toEqual([7]);
  });

  it("returns {7, 14, 30} when the corpus was activated 35 days ago", async () => {
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const client = {
      query: vi.fn(async () => ({
        rows: [{ corpus_activated_at: old }],
        rowCount: 1,
      })),
    };
    const active = await detectActiveWindows(
      client as unknown as Parameters<typeof detectActiveWindows>[0],
    );
    expect([...active].sort()).toEqual([14, 30, 7]);
  });
});
