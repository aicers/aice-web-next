import { describe, expect, it, vi } from "vitest";
import { CRITICAL_CATEGORIES } from "@/lib/triage/baseline/categories";
import {
  insertAutoStory,
  insertCuratedStory,
  readR1Candidates,
  readR3Candidates,
} from "@/lib/triage/story/repository";
import type { CandidateEvent } from "@/lib/triage/story/rules";
import { STORY_MEMBER_CAP } from "@/lib/triage/story/rules";

function event(
  partial: Omit<Partial<CandidateEvent>, "eventTime"> & {
    eventKey: string;
    eventTime: string;
  },
): CandidateEvent {
  const { eventTime, ...rest } = partial;
  return {
    kind: "HttpThreat",
    origAddr: "10.0.0.5",
    category: null,
    selectorTags: [],
    rawScore: 0,
    ...rest,
    eventTime: new Date(eventTime),
  };
}

interface FakeHandles {
  client: unknown;
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
}

function makeClient(): FakeHandles {
  let nextGroupId = 1;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO event_group ")) {
      const id = String(nextGroupId);
      nextGroupId += 1;
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO event_group_member")) {
      return { rows: [], rowCount: (params?.length ?? 0) / 3 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query }, queries };
}

describe("insertCuratedStory", () => {
  it("writes kind = 'analyst_curated' with NULL correlation_rule_id and no ON CONFLICT clause", async () => {
    const h = makeClient();
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
        members: [
          event({
            eventKey: "1",
            eventTime: "2026-05-09T12:00:00Z",
            category: "IMPACT",
          }),
          event({
            eventKey: "2",
            eventTime: "2026-05-09T12:30:00Z",
            category: "EXFILTRATION",
          }),
        ],
      },
    );
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    expect(insertGroup).toBeDefined();
    // Curated rows skip the partial unique-index dedup (scoped to
    // kind = 'auto_correlated'), so the INSERT must NOT carry an
    // ON CONFLICT clause that would suppress legitimate repeat
    // saves on the same (asset, window).
    expect(insertGroup?.sql).not.toMatch(/ON CONFLICT/);
    expect(insertGroup?.sql).toContain("'analyst_curated'");
    // correlation_rule_id is a literal NULL in the VALUES clause
    // (curated rows have no rule), not a bound parameter.
    expect(insertGroup?.sql).toMatch(/'analyst_curated',\s*NULL/);
  });

  it("populates the §7 fixed-key summary_payload from members", async () => {
    const h = makeClient();
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
        members: [
          event({
            eventKey: "1",
            eventTime: "2026-05-09T12:00:00Z",
            kind: "HttpThreat",
            category: "IMPACT",
            rawScore: 1.5,
            selectorTags: ["S2-severe"],
          }),
          event({
            eventKey: "2",
            eventTime: "2026-05-09T12:30:00Z",
            kind: "DnsCovertChannel",
            category: "EXFILTRATION",
            rawScore: 2.5,
            selectorTags: [],
          }),
        ],
      },
    );
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    // summary_payload is the last positional parameter on the
    // curated INSERT (param $6 — STORY_VERSION, start, end, asset,
    // score, summary).
    const summaryJson = insertGroup?.params?.[5] as string;
    const summary = JSON.parse(summaryJson);
    expect(Object.keys(summary).sort()).toEqual([
      "categoryHistogram",
      "distinctAssetCount",
      "durationMs",
      "kindHistogram",
      "memberCount",
      "topRawScore",
    ]);
    expect(summary.memberCount).toBe(2);
    expect(summary.topRawScore).toBe(2.5);
  });

  it("enforces the §8 member cap (curated saves cannot exceed STORY_MEMBER_CAP)", async () => {
    const h = makeClient();
    const members: CandidateEvent[] = [];
    for (let i = 0; i < STORY_MEMBER_CAP + 10; i += 1) {
      members.push(
        event({
          eventKey: String(1000 + i),
          eventTime: `2026-05-09T12:${String(i % 60).padStart(2, "0")}:00Z`,
        }),
      );
    }
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T13:00:00Z"),
        members,
      },
    );
    const insertMembers = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group_member"),
    );
    // 3 params per member row.
    expect((insertMembers?.params?.length ?? 0) / 3).toBe(STORY_MEMBER_CAP);
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    const summary = JSON.parse(insertGroup?.params?.[5] as string);
    expect(summary.memberCount).toBe(STORY_MEMBER_CAP);
  });
});

describe("readR1Candidates — SQL push-down for measurement gate", () => {
  function makeReadClient(): {
    client: unknown;
    queries: Array<{ sql: string; params: unknown[] | undefined }>;
  } {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    return { client: { query }, queries };
  }

  it("pushes orig_addr IS NOT NULL and category = ANY into SQL with a [start, end] range", async () => {
    const h = makeReadClient();
    const start = new Date("2026-05-09T11:00:00Z");
    const end = new Date("2026-05-09T13:00:00Z");
    await readR1Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: start,
      memberScanEnd: end,
    });
    expect(h.queries).toHaveLength(1);
    const q = h.queries[0];
    expect(q.sql).toMatch(/event_time >= \$1/);
    expect(q.sql).toMatch(/event_time <= \$2/);
    expect(q.sql).toMatch(/orig_addr IS NOT NULL/);
    expect(q.sql).toMatch(/category = ANY\(\$3::text\[\]\)/);
    expect(q.params?.[0]).toEqual(start);
    expect(q.params?.[1]).toEqual(end);
    expect(q.params?.[2]).toEqual(
      expect.arrayContaining(Array.from(CRITICAL_CATEGORIES)),
    );
  });

  it("omits the lower bound on first tick (memberScanStart === null)", async () => {
    const h = makeReadClient();
    const end = new Date("2026-05-09T13:00:00Z");
    await readR1Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: null,
      memberScanEnd: end,
    });
    const q = h.queries[0];
    expect(q.sql).not.toMatch(/event_time >= /);
    expect(q.sql).toMatch(/event_time <= \$1/);
    expect(q.sql).toMatch(/category = ANY\(\$2::text\[\]\)/);
    expect(q.params).toHaveLength(2);
  });
});

describe("readR3Candidates — two-phase per-asset access for measurement gate", () => {
  // The R3 measurement gate from the issue specifically requires
  // EXPLAIN ANALYZE on the same-asset-1h scan, confirming use of
  // the `orig_addr` GiST index. The implementation is two phases:
  //   phase 1 — `GROUP BY orig_addr HAVING COUNT(*) >= 3` to
  //             pre-aggregate candidate assets;
  //   phase 2 — `orig_addr = ANY($::inet[])` per-asset row read,
  //             which the planner can resolve via the GiST index.
  function makeReadClient(opts?: {
    phase1Rows?: Array<{ orig_addr: string }>;
  }): {
    client: unknown;
    queries: Array<{ sql: string; params: unknown[] | undefined }>;
  } {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let queryIdx = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const idx = queryIdx;
      queryIdx += 1;
      // First call is phase 1 (candidate-asset aggregate). Returning
      // a non-empty rows array triggers the phase 2 SELECT in the
      // implementation; an empty array short-circuits.
      if (idx === 0 && opts?.phase1Rows) {
        return { rows: opts.phase1Rows, rowCount: opts.phase1Rows.length };
      }
      return { rows: [], rowCount: 0 };
    });
    return { client: { query }, queries };
  }

  it("phase 1: pre-aggregates candidate assets with GROUP BY / HAVING COUNT(*) >= 3", async () => {
    const h = makeReadClient();
    const start = new Date("2026-05-09T11:00:00Z");
    const end = new Date("2026-05-09T13:00:00Z");
    await readR3Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: start,
      memberScanEnd: end,
    });
    const phase1 = h.queries[0];
    expect(phase1.sql).toMatch(/event_time >= \$1/);
    expect(phase1.sql).toMatch(/event_time <= \$2/);
    expect(phase1.sql).toMatch(/orig_addr IS NOT NULL/);
    expect(phase1.sql).toMatch(/selector_tags && \$3::text\[\]/);
    expect(phase1.sql).toMatch(/GROUP BY orig_addr/);
    expect(phase1.sql).toMatch(/HAVING COUNT\(\*\) >= 3/);
    expect(phase1.params?.[0]).toEqual(start);
    expect(phase1.params?.[1]).toEqual(end);
    expect(phase1.params?.[2]).toEqual(
      expect.arrayContaining(["S2-severe", "unlabeled-cluster"]),
    );
  });

  it("phase 2: per-asset member read uses orig_addr = ANY($::inet[]) (the measurement-gate target)", async () => {
    const h = makeReadClient({
      phase1Rows: [{ orig_addr: "10.0.0.5" }, { orig_addr: "10.0.0.7" }],
    });
    const start = new Date("2026-05-09T11:00:00Z");
    const end = new Date("2026-05-09T13:00:00Z");
    await readR3Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: start,
      memberScanEnd: end,
    });
    expect(h.queries).toHaveLength(2);
    const phase2 = h.queries[1];
    expect(phase2.sql).toMatch(/event_time >= \$1/);
    expect(phase2.sql).toMatch(/event_time <= \$2/);
    expect(phase2.sql).toMatch(/orig_addr = ANY\(\$3::inet\[\]\)/);
    expect(phase2.sql).toMatch(/selector_tags && \$4::text\[\]/);
    expect(phase2.params?.[0]).toEqual(start);
    expect(phase2.params?.[1]).toEqual(end);
    expect(phase2.params?.[2]).toEqual(["10.0.0.5", "10.0.0.7"]);
    expect(phase2.params?.[3]).toEqual(
      expect.arrayContaining(["S2-severe", "unlabeled-cluster"]),
    );
  });

  it("phase 1 returns no candidate assets: phase 2 is skipped (no tenant-wide row materialization)", async () => {
    const h = makeReadClient();
    const start = new Date("2026-05-09T11:00:00Z");
    const end = new Date("2026-05-09T13:00:00Z");
    const rows = await readR3Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: start,
      memberScanEnd: end,
    });
    expect(rows).toEqual([]);
    expect(h.queries).toHaveLength(1);
  });

  it("omits the lower bound on first tick (memberScanStart === null) in both phases", async () => {
    const h = makeReadClient({
      phase1Rows: [{ orig_addr: "10.0.0.5" }],
    });
    const end = new Date("2026-05-09T13:00:00Z");
    await readR3Candidates({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      memberScanStart: null,
      memberScanEnd: end,
    });
    expect(h.queries).toHaveLength(2);
    const phase1 = h.queries[0];
    expect(phase1.sql).not.toMatch(/event_time >= /);
    expect(phase1.sql).toMatch(/event_time <= \$1/);
    expect(phase1.sql).toMatch(/selector_tags && \$2::text\[\]/);
    expect(phase1.params).toHaveLength(2);
    const phase2 = h.queries[1];
    expect(phase2.sql).not.toMatch(/event_time >= /);
    expect(phase2.sql).toMatch(/event_time <= \$1/);
    expect(phase2.sql).toMatch(/orig_addr = ANY\(\$2::inet\[\]\)/);
    expect(phase2.sql).toMatch(/selector_tags && \$3::text\[\]/);
    expect(phase2.params).toHaveLength(3);
  });
});

describe("insertAutoStory — β carry-over (rebuild path, #565)", () => {
  function autoDraft() {
    return {
      ruleId: "R3" as const,
      primaryAsset: "10.0.0.5",
      timeWindowStart: new Date("2026-05-03T11:58:00Z"),
      timeWindowEnd: new Date("2026-05-03T12:00:00Z"),
      members: [
        event({
          eventKey: "1",
          eventTime: "2026-05-03T11:58:00Z",
          category: "IMPACT",
          selectorTags: ["S2-severe"],
        }),
      ],
      score: 1,
      summary: {
        kindHistogram: { HttpThreat: 1 },
        categoryHistogram: { IMPACT: 1 },
        memberCount: 1,
        durationMs: 0,
        distinctAssetCount: 1,
        topRawScore: 0,
      },
    };
  }

  it("omits β columns when carryOver is undefined (cadence path)", async () => {
    const h = makeClient();
    await insertAutoStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      autoDraft(),
    );
    const ins = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    expect(ins).toBeDefined();
    // β columns are not in the INSERT column list when no carry-over.
    expect(ins?.sql).not.toContain("last_sent_at");
    expect(ins?.sql).not.toContain("send_count");
    expect(ins?.sql).not.toContain("last_sent_by");
    expect(ins?.sql).toContain("ON CONFLICT");
  });

  it("includes β columns and binds carry-over values when provided", async () => {
    const h = makeClient();
    const lastSentAt = new Date("2026-05-02T00:00:00Z");
    const lastSentBy = "00000000-0000-0000-0000-000000000001";
    await insertAutoStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      autoDraft(),
      { lastSentAt, sendCount: 3, lastSentBy },
    );
    const ins = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    expect(ins).toBeDefined();
    expect(ins?.sql).toContain("last_sent_at");
    expect(ins?.sql).toContain("send_count");
    expect(ins?.sql).toContain("last_sent_by");
    expect(ins?.sql).toContain("ON CONFLICT");
    expect(ins?.params).toContain(lastSentAt);
    expect(ins?.params).toContain(3);
    expect(ins?.params).toContain(lastSentBy);
  });
});

describe("insertCuratedStory — primary_asset NULL", () => {
  it("accepts a NULL primary_asset (analyst curated rows are not subject to the partial-index NULL exclusion)", async () => {
    const h = makeClient();
    await expect(
      insertCuratedStory(
        // biome-ignore lint/suspicious/noExplicitAny: fake test client
        h.client as any,
        {
          primaryAsset: null,
          timeWindowStart: new Date("2026-05-09T12:00:00Z"),
          timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
          members: [
            event({
              eventKey: "1",
              eventTime: "2026-05-09T12:00:00Z",
              origAddr: null,
              category: "IMPACT",
            }),
          ],
        },
      ),
    ).resolves.toEqual({ groupId: "1" });
  });
});
