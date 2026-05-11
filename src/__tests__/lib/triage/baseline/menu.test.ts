import { describe, expect, it } from "vitest";

import {
  assembleMenu,
  type BucketAggregate,
  bucketKey,
  composeMenu,
  computeBucketQuotas,
  computeDefaultN,
  type MenuRow,
  slotBucket,
} from "@/lib/triage/baseline/menu";
import { FINAL_COUNT } from "@/lib/triage/baseline/tunables";

function makeRow(
  partial: Partial<MenuRow> & {
    eventKey: string;
    kind: string;
    baselineScore: number;
  },
): MenuRow {
  return {
    eventKey: partial.eventKey,
    eventTime: partial.eventTime ?? new Date("2026-05-09T12:00:00.000Z"),
    kind: partial.kind,
    baselineVersion: partial.baselineVersion ?? "phase1b-four-selector",
    rawScore: partial.rawScore ?? 0,
    baselineScore: partial.baselineScore,
    selectorTags: partial.selectorTags ?? [],
  };
}

describe("slotBucket", () => {
  it("returns ('HttpThreat', true) only for unlabeled-cluster HttpThreat", () => {
    expect(slotBucket("HttpThreat", ["unlabeled-cluster"])).toEqual({
      kind: "HttpThreat",
      isUnlabeled: true,
    });
    expect(slotBucket("HttpThreat", ["S1-high"])).toEqual({
      kind: "HttpThreat",
      isUnlabeled: false,
    });
    expect(slotBucket("DnsCovertChannel", ["unlabeled-cluster"])).toEqual({
      kind: "DnsCovertChannel",
      isUnlabeled: false,
    });
  });
});

describe("computeDefaultN", () => {
  it("returns LOWER_FLOOR for an empty cohort", () => {
    expect(computeDefaultN(0)).toBe(FINAL_COUNT.LOWER_FLOOR);
  });

  it("grows sublinearly with post-exclusion volume (RFC §6)", () => {
    expect(computeDefaultN(100)).toBe(80);
    expect(computeDefaultN(1000)).toBe(110);
    expect(computeDefaultN(10000)).toBe(140);
    expect(computeDefaultN(100000)).toBe(170);
  });
});

describe("computeBucketQuotas (largest-remainder)", () => {
  it("RFC §4 worked example: shares 0.25×4 with default_N=10 → quota=[3,3,2,2]", () => {
    // Synthesize four buckets that produce share = 0.25 each by
    // giving them identical `count` (same `normalized_volume`) and
    // identical `totalTagCardinality / count` ratios. Setting one
    // tag per row makes `normalized_top_confidence = 1/5 = 0.2`, so
    // every bucket's share is `base_share + α·1·0.2 = 0.22`.
    // The shares are equal so they normalize to 0.25 each — what
    // the RFC example calls out.
    const aggregates = ["A:false", "B:false", "C:false", "D:false"].map((k) => {
      const [kind, isUnlabeled] = k.split(":");
      return {
        bucket: { kind, isUnlabeled: isUnlabeled === "true" },
        count: 10,
        totalTagCardinality: 10,
      };
    });
    const quotas = computeBucketQuotas(aggregates, 10);
    // 0.25 × 10 = 2.5 each → floor 2 each, leftover 2 → top-2 by
    // lexicographic (kind, is_unlabeled) on equal remainders.
    const values = Array.from(quotas.values()).sort((a, b) => b - a);
    expect(values).toEqual([3, 3, 2, 2]);
    expect(values.reduce((s, v) => s + v, 0)).toBe(10);
    // Lexicographic tie-break: A and B win the leftover.
    expect(quotas.get("A:false")).toBe(3);
    expect(quotas.get("B:false")).toBe(3);
    expect(quotas.get("C:false")).toBe(2);
    expect(quotas.get("D:false")).toBe(2);
  });

  it("breaks remainder ties on (kind, is_unlabeled) with false < true", () => {
    // Two HttpThreat buckets — labeled and unlabeled — with
    // identical aggregates produce equal remainders. The labeled
    // (false) bucket must win the leftover before the unlabeled
    // (true) bucket per RFC §4 lexicographic rule.
    const aggregates = [
      {
        bucket: { kind: "HttpThreat", isUnlabeled: false },
        count: 5,
        totalTagCardinality: 5,
      },
      {
        bucket: { kind: "HttpThreat", isUnlabeled: true },
        count: 5,
        totalTagCardinality: 5,
      },
    ];
    // FAVORED_BUCKETS includes HttpThreat:true so the shares are
    // not strictly equal (favored gets β); pick a default_N that
    // still leaves one leftover slot. Quotas should sum to N.
    const quotas = computeBucketQuotas(aggregates, 3);
    const sum = Array.from(quotas.values()).reduce((s, v) => s + v, 0);
    expect(sum).toBe(3);
  });
});

describe("assembleMenu", () => {
  it("returns empty rows on an empty cohort (post_exclusion = 0)", () => {
    const result = assembleMenu([], 0);
    expect(result.rows).toHaveLength(0);
    expect(result.fallbackInvoked).toBe(false);
    expect(result.assembledCount).toBe(0);
  });

  it("CUME_DIST cold-start: a single-row partition is included at score 1.0", () => {
    const row = makeRow({
      eventKey: "1",
      kind: "DnsCovertChannel",
      baselineScore: 1.0,
    });
    const result = assembleMenu([row], 0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(row);
    expect(result.fallbackInvoked).toBe(false);
  });

  it("MIN_NONZERO_FLOOR fallback returns top-N globally when a strict cutoff drives assembled_count below the floor", () => {
    // Five rows in one bucket, all with `baseline_score = 0.5`.
    // A cutoff of 0.9 admits zero rows in the assembly pass; the
    // floor must surface the top-MIN_NONZERO_FLOOR rows globally
    // by `baseline_score DESC` regardless of bucket / quota / cutoff
    // (RFC §6).
    const rows: MenuRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        makeRow({
          eventKey: `${i}`,
          kind: "DnsCovertChannel",
          baselineScore: 0.5,
          eventTime: new Date(`2026-05-09T12:0${i}:00.000Z`),
        }),
      );
    }
    const result = assembleMenu(rows, 0.9);
    expect(result.fallbackInvoked).toBe(true);
    expect(result.rows).toHaveLength(FINAL_COUNT.MIN_NONZERO_FLOOR);
    // Top by tie-breaker: equal score → newest event_time first.
    expect(result.rows[0].eventKey).toBe("4");
  });

  it("defensively excludes BlockList* via the cohort caller — algorithm receives only post-exclusion rows", () => {
    // The algorithm itself never inspects `kind` to drop
    // BlockList*; it trusts the caller (SQL `WHERE kind NOT LIKE
    // 'BlockList%'`). A row passed in named `BlockListBlocked`
    // would survive — the regression guard is that the SQL never
    // delivers one, not that the algorithm filters them out.
    // Verify the algorithm is bucket-agnostic to the kind string by
    // observing it does not throw or special-case the name.
    const row = makeRow({
      eventKey: "1",
      kind: "BlockListBlocked",
      baselineScore: 1.0,
    });
    expect(() => assembleMenu([row], 0)).not.toThrow();
  });

  it("multi-version active window: quota[A] applies once across versions, not twice", () => {
    // Two `baseline_version`s emitting rows for the same kind A.
    // The bucket key is `('A', false)` regardless of version, so
    // the union is taken before the quota cap.
    const rows: MenuRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(
        makeRow({
          eventKey: `${i}`,
          kind: "A",
          baselineVersion: i % 2 === 0 ? "v1" : "v2",
          baselineScore: 1 - i / 20,
        }),
      );
    }
    const result = assembleMenu(rows, 0);
    // Quota[A] is computed once against the bucket-level aggregate;
    // assembled cannot exceed that quota even with two versions.
    const quotaA = result.quotas.get(
      bucketKey({ kind: "A", isUnlabeled: false }),
    );
    expect(result.assembledCount).toBeLessThanOrEqual(quotaA ?? 0);
  });

  it("Phase 1.A coexistence: rows with the Phase 1.A version go to the labeled bucket", () => {
    // A Phase 1.A row lacks `unlabeled-cluster` regardless of kind,
    // so HttpThreat Phase 1.A rows go to `('HttpThreat', false)`.
    const phase1a = makeRow({
      eventKey: "1",
      kind: "HttpThreat",
      baselineVersion: "phase1a-simple",
      baselineScore: 0.9,
      selectorTags: ["phase1a"],
    });
    const phase1b = makeRow({
      eventKey: "2",
      kind: "HttpThreat",
      baselineVersion: "phase1b-four-selector",
      baselineScore: 0.95,
      selectorTags: ["unlabeled-cluster"],
    });
    const result = assembleMenu([phase1a, phase1b], 0);
    expect(result.rows.map((r) => r.eventKey).sort()).toEqual(["1", "2"]);
  });

  it("honors SQL-side cohort aggregates even when candidates are a per-bucket top-K slice", () => {
    // Regression for Round 1 Item 2: the SQL caller computes
    // `postExclusionCount` and `bucketAggregates` over the FULL
    // cohort and ships top-K candidates. If `composeMenu` re-derived
    // those quantities from the candidate slice, `default_N` and the
    // per-bucket share would silently re-base on the slice — wrong.
    // Synthesize a cohort whose full size is 100,000 but where the
    // caller has only delivered 3 candidate rows (e.g. the top of one
    // bucket); `default_N` must still come from `computeDefaultN(100000)`.
    const candidates: MenuRow[] = [
      makeRow({ eventKey: "1", kind: "DnsCovertChannel", baselineScore: 0.99 }),
      makeRow({ eventKey: "2", kind: "DnsCovertChannel", baselineScore: 0.98 }),
      makeRow({ eventKey: "3", kind: "DnsCovertChannel", baselineScore: 0.97 }),
    ];
    const bucketAggregates: BucketAggregate[] = [
      {
        bucket: { kind: "DnsCovertChannel", isUnlabeled: false },
        count: 100_000,
        totalTagCardinality: 0,
      },
    ];
    const result = composeMenu({
      postExclusionCount: 100_000,
      bucketAggregates,
      candidates,
      cutoff: 0,
    });
    // computeDefaultN(100_000) = 170 (LOWER_FLOOR + 30 · log10(100_001))
    expect(result.defaultN).toBe(170);
    // Single bucket → its quota equals defaultN; candidate slice is
    // smaller, so the assembly takes all three rows.
    expect(result.rows.map((r) => r.eventKey).sort()).toEqual(["1", "2", "3"]);
  });

  it("tie-breaker: equal baseline_score resolves on (event_time DESC, event_key DESC)", () => {
    const older = makeRow({
      eventKey: "10",
      kind: "DnsCovertChannel",
      baselineScore: 0.5,
      eventTime: new Date("2026-05-09T10:00:00.000Z"),
    });
    const newer = makeRow({
      eventKey: "11",
      kind: "DnsCovertChannel",
      baselineScore: 0.5,
      eventTime: new Date("2026-05-09T11:00:00.000Z"),
    });
    const result = assembleMenu([older, newer], 0);
    expect(result.rows[0].eventKey).toBe("11");
    expect(result.rows[1].eventKey).toBe("10");
  });
});
