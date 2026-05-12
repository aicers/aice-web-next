import { describe, expect, it, vi } from "vitest";

import { runStepF } from "@/lib/triage/story/correlator";

interface FakeRow {
  event_key: string;
  event_time: Date;
  kind: string;
  orig_addr: string | null;
  category: string | null;
  selector_tags: string[];
  raw_score: number;
}

interface FakeClientHandles {
  /** Rows the candidate-event SELECT returns. */
  setCandidates: (rows: FakeRow[]) => void;
  /** Current watermark value the singleton SELECT returns. */
  setWatermark: (value: Date | null) => void;
  /** Number of `event_group` INSERTs that returned a non-NULL id
   *  (i.e., were not suppressed by the partial unique index). */
  insertsMade: () => number;
  /** Last value `advanceStoryWatermark` UPDATE was called with. */
  lastWatermarkUpdate: () => Date | null;
  /** Captured SQL log for assertions. */
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  client: unknown;
  /** Force the next `event_group` INSERT to return zero rows
   *  (simulating ON CONFLICT DO NOTHING suppressing the insert). */
  suppressNextInsert: () => void;
  /** Sequence of returned group ids — exposed for member-INSERT
   *  assertions. */
  groupIds: string[];
}

function makeClient(): FakeClientHandles {
  let candidates: FakeRow[] = [];
  let watermark: Date | null = null;
  let nextGroupId = 1;
  let suppressNext = false;
  let inserts = 0;
  let lastUpdate: Date | null = null;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const groupIds: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("FROM baseline_corpus_state")) {
      return {
        rows: [{ story_finalized_through: watermark }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM baseline_triaged_event")) {
      return { rows: candidates, rowCount: candidates.length };
    }
    if (sql.includes("INSERT INTO event_group ")) {
      if (suppressNext) {
        suppressNext = false;
        return { rows: [], rowCount: 0 };
      }
      const id = String(nextGroupId);
      nextGroupId += 1;
      inserts += 1;
      groupIds.push(id);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO event_group_member")) {
      return { rows: [], rowCount: (params?.length ?? 0) / 3 };
    }
    if (sql.includes("UPDATE baseline_corpus_state")) {
      lastUpdate = (params?.[0] as Date) ?? null;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    setCandidates: (rows) => {
      candidates = rows;
    },
    setWatermark: (value) => {
      watermark = value;
    },
    insertsMade: () => inserts,
    lastWatermarkUpdate: () => lastUpdate,
    queries,
    client: { query },
    suppressNextInsert: () => {
      suppressNext = true;
    },
    groupIds,
  };
}

const SLOP_MS = 30 * 60 * 1000;

describe("runStepF — empty page no-op", () => {
  it("does NOT advance the watermark when the page has zero survivors", async () => {
    const h = makeClient();
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: null,
    });
    expect(result).toEqual({ storiesInserted: 0, newWatermark: null });
    // No UPDATE issued, no SELECT issued.
    expect(h.queries).toEqual([]);
  });
});

describe("runStepF — slop window finalization filter", () => {
  it("does not finalize a draft whose time_window_end falls within the last 30 minutes of the page", async () => {
    const pageMax = new Date("2026-05-09T13:00:00Z");
    const pageMin = new Date("2026-05-09T12:00:00Z");
    const h = makeClient();
    // Build an R3 cluster whose end (12:55) sits inside the last
    // 30 minutes of the page (12:30..13:00), so it must NOT
    // finalize this tick.
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T12:50:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T12:53:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "3",
        event_time: new Date("2026-05-09T12:55:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["unlabeled-cluster"],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(0);
    expect(h.insertsMade()).toBe(0);
    // Watermark still advances even when no Stories finalize.
    expect(h.lastWatermarkUpdate()).toEqual(
      new Date(pageMax.getTime() - SLOP_MS),
    );
    expect(result.newWatermark).toEqual(new Date(pageMax.getTime() - SLOP_MS));
  });

  it("DOES finalize when the cluster end is at-or-before new_horizon", async () => {
    const pageMax = new Date("2026-05-09T13:00:00Z");
    const pageMin = new Date("2026-05-09T10:00:00Z");
    const h = makeClient();
    // Cluster end 12:30:00 = new_horizon exactly. The filter is
    // `endMs <= newHorizonMs`, so this finalizes.
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T11:50:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T12:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "3",
        event_time: new Date("2026-05-09T12:30:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(1);
    expect(h.insertsMade()).toBe(1);
  });
});

describe("runStepF — first-tick / NULL watermark", () => {
  it("uses pageEventTimeRange.min as the member-scan lower bound (no corpus_activated_at floor)", async () => {
    const pageMax = new Date("2026-05-09T13:00:00Z");
    const pageMin = new Date("2026-05-09T10:00:00Z");
    const h = makeClient();
    // No previous watermark, so the scan lower bound is the
    // page's own `event_time.min`. The corpus_activated_at column
    // is never consulted.
    h.setWatermark(null);
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T11:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "INITIAL_ACCESS",
        selector_tags: [],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T11:05:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "COMMAND_AND_CONTROL",
        selector_tags: [],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(1);

    // The member-scan SELECT used pageMin as its lower bound.
    const scanQuery = h.queries.find((q) =>
      q.sql.includes("FROM baseline_triaged_event"),
    );
    expect(scanQuery?.params?.[0]).toEqual(pageMin);
    expect(scanQuery?.params?.[1]).toEqual(pageMax);
  });
});

describe("runStepF — slop-replay member lookback", () => {
  it("scans [previous_watermark − max_rule_window, page_max] so cross-watermark members are included", async () => {
    const pageMax = new Date("2026-05-09T15:00:00Z");
    const pageMin = new Date("2026-05-09T13:30:00Z");
    const previousWatermark = new Date("2026-05-09T13:30:00Z");
    const h = makeClient();
    h.setWatermark(previousWatermark);
    // The R3 cluster's last member sits at previous_watermark + ε,
    // earlier members sit at previous_watermark − 50 min (inside
    // the 1-hour rule window). A regression that scans only from
    // previous_watermark onward would miss the earlier members
    // and the cluster would have member_count = 1 < 3.
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T12:40:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T12:45:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "3",
        event_time: new Date("2026-05-09T13:31:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(1);

    // The member-scan SELECT used previousWatermark − 1h as its
    // lower bound (MAX_RULE_WINDOW_MS).
    const scanQuery = h.queries.find((q) =>
      q.sql.includes("FROM baseline_triaged_event"),
    );
    const expectedLower = new Date(
      previousWatermark.getTime() - 60 * 60 * 1000,
    );
    expect(scanQuery?.params?.[0]).toEqual(expectedLower);
  });

  it("skips drafts whose time_window_end is already past on the previous watermark", async () => {
    // The cluster's end falls at-or-before the previous watermark,
    // so it was already finalized on a prior tick. The correlator
    // must NOT re-insert.
    const previousWatermark = new Date("2026-05-09T14:00:00Z");
    const pageMax = new Date("2026-05-09T15:00:00Z");
    const pageMin = new Date("2026-05-09T13:00:00Z");
    const h = makeClient();
    h.setWatermark(previousWatermark);
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T13:10:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T13:30:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "3",
        event_time: new Date("2026-05-09T13:55:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(0);
    expect(h.insertsMade()).toBe(0);
  });
});

describe("runStepF — idempotency", () => {
  it("ON CONFLICT DO NOTHING — a suppressed event_group INSERT does not count as a new story", async () => {
    const pageMax = new Date("2026-05-09T13:00:00Z");
    const pageMin = new Date("2026-05-09T11:00:00Z");
    const h = makeClient();
    h.suppressNextInsert();
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T12:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "INITIAL_ACCESS",
        selector_tags: [],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T12:05:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "COMMAND_AND_CONTROL",
        selector_tags: [],
        raw_score: 1.5,
      },
    ]);
    const result = await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    expect(result.storiesInserted).toBe(0);
  });
});

describe("runStepF — summary_payload contract", () => {
  it("the INSERTed summary_payload carries every fixed key from §7", async () => {
    const pageMax = new Date("2026-05-09T13:00:00Z");
    const pageMin = new Date("2026-05-09T11:00:00Z");
    const h = makeClient();
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-09T12:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "INITIAL_ACCESS",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-09T12:05:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "COMMAND_AND_CONTROL",
        selector_tags: [],
        raw_score: 2.0,
      },
    ]);
    await runStepF({
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      client: h.client as any,
      pageEventTimeRange: { min: pageMin, max: pageMax },
    });
    const insert = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    expect(insert).toBeDefined();
    // summary_payload is the last positional parameter on the
    // INSERT (param $7).
    const summaryJson = insert?.params?.[6] as string;
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
    expect(summary.distinctAssetCount).toBe(1);
    expect(summary.topRawScore).toBe(2.0);
  });
});

describe("runStepF — abort signal", () => {
  it("throws if the signal was aborted before evaluation", async () => {
    const h = makeClient();
    const ac = new AbortController();
    ac.abort();
    await expect(
      runStepF({
        // biome-ignore lint/suspicious/noExplicitAny: fake test client
        client: h.client as any,
        pageEventTimeRange: {
          min: new Date("2026-05-09T11:00:00Z"),
          max: new Date("2026-05-09T13:00:00Z"),
        },
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
