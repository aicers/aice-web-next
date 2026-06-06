import { beforeEach, describe, expect, it, vi } from "vitest";

// The sweep obtains its own customer pool, so we mock the resolver to
// hand back a pool that `connect()`s to the per-test fake client.
const hoisted = vi.hoisted(() => ({
  connect: null as null | (() => unknown),
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: async () => ({
    connect: async () => {
      if (hoisted.connect === null) throw new Error("no client wired");
      return hoisted.connect();
    },
  }),
  CustomerNotFoundError: class CustomerNotFoundError extends Error {},
}));

import { runLowslowSweep } from "@/lib/triage/baseline/lowslow-sweep";

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
  setCandidates: (rows: FakeRow[]) => void;
  setHorizon: (value: Date | null) => void;
  setLowslowWatermark: (value: Date | null) => void;
  setLockAcquired: (value: boolean) => void;
  suppressNextInsert: () => void;
  insertsMade: () => number;
  lastWatermarkUpdate: () => Date | null;
  committed: () => boolean;
  rolledBack: () => boolean;
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  client: { query: ReturnType<typeof vi.fn>; release: () => void };
}

function makeClient(): FakeClientHandles {
  let candidates: FakeRow[] = [];
  let horizon: Date | null = null;
  let lowslowWm: Date | null = null;
  let lockAcquired = true;
  let suppressNext = false;
  let inserts = 0;
  let nextGroupId = 1;
  let lastUpdate: Date | null = null;
  let didCommit = false;
  let didRollback = false;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql === "BEGIN") return { rows: [], rowCount: 0 };
    if (sql === "COMMIT") {
      didCommit = true;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      didRollback = true;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
    }
    if (sql.includes("UPDATE baseline_corpus_state")) {
      lastUpdate = (params?.[0] as Date) ?? null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("lowslow_finalized_through")) {
      return {
        rows: [{ lowslow_finalized_through: lowslowWm }],
        rowCount: 1,
      };
    }
    if (sql.includes("story_finalized_through")) {
      return { rows: [{ story_finalized_through: horizon }], rowCount: 1 };
    }
    if (sql.includes("FROM baseline_triaged_event")) {
      if (sql.includes("GROUP BY orig_addr")) {
        // Phase 1: distinct candidate assets. The mock skips the
        // member/bucket HAVING floors — detectR6 re-applies them.
        const assets = Array.from(
          new Set(
            candidates
              .map((c) => c.orig_addr)
              .filter((a): a is string => a !== null),
          ),
        );
        return {
          rows: assets.map((orig_addr) => ({ orig_addr })),
          rowCount: assets.length,
        };
      }
      // Phase 2: member rows for the candidate assets.
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
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO event_group_member")) {
      return { rows: [], rowCount: (params?.length ?? 0) / 3 };
    }
    return { rows: [], rowCount: 0 };
  });

  return {
    setCandidates: (rows) => {
      candidates = rows;
    },
    setHorizon: (value) => {
      horizon = value;
    },
    setLowslowWatermark: (value) => {
      lowslowWm = value;
    },
    setLockAcquired: (value) => {
      lockAcquired = value;
    },
    suppressNextInsert: () => {
      suppressNext = true;
    },
    insertsMade: () => inserts,
    lastWatermarkUpdate: () => lastUpdate,
    committed: () => didCommit,
    rolledBack: () => didRollback,
    queries,
    client: { query, release: () => {} },
  };
}

const HOUR = 60 * 60 * 1000;

/** A beacon: 3 events on one asset, one per hour over 3 UTC hour
 *  buckets, all overlapping the R6 selector set. */
function beaconRows(): FakeRow[] {
  return [
    {
      event_key: "b1",
      event_time: new Date("2026-05-09T01:05:00Z"),
      kind: "HttpThreat",
      orig_addr: "10.0.0.5",
      category: "COMMAND_AND_CONTROL",
      selector_tags: ["S3-recurring"],
      raw_score: 1.0,
    },
    {
      event_key: "b2",
      event_time: new Date("2026-05-09T02:10:00Z"),
      kind: "HttpThreat",
      orig_addr: "10.0.0.5",
      category: "COMMAND_AND_CONTROL",
      selector_tags: ["S3-recurring"],
      raw_score: 1.0,
    },
    {
      event_key: "b3",
      event_time: new Date("2026-05-09T03:15:00Z"),
      kind: "HttpThreat",
      orig_addr: "10.0.0.5",
      category: "COMMAND_AND_CONTROL",
      selector_tags: ["S3-recurring"],
      raw_score: 1.0,
    },
  ];
}

beforeEach(() => {
  hoisted.connect = null;
});

describe("runLowslowSweep — horizon guards", () => {
  it("is a no-op when story_finalized_through IS NULL (cadence not settled)", async () => {
    const h = makeClient();
    h.setHorizon(null);
    h.setLowslowWatermark(null);
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(0);
    expect(result.newWatermark).toBeNull();
    // No member-scan, no watermark UPDATE.
    expect(
      h.queries.some((q) => q.sql.includes("FROM baseline_triaged_event")),
    ).toBe(false);
    expect(h.lastWatermarkUpdate()).toBeNull();
    expect(h.committed()).toBe(true);
  });

  it("early-returns before the member-scan when H <= lowslow watermark", async () => {
    const h = makeClient();
    h.setHorizon(new Date("2026-05-09T05:00:00Z"));
    h.setLowslowWatermark(new Date("2026-05-09T05:00:00Z"));
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(0);
    expect(result.newWatermark).toBeNull();
    expect(
      h.queries.some((q) => q.sql.includes("FROM baseline_triaged_event")),
    ).toBe(false);
    expect(h.lastWatermarkUpdate()).toBeNull();
  });

  it("skips cleanly when the advisory lock is unavailable", async () => {
    const h = makeClient();
    h.setLockAcquired(false);
    h.setHorizon(new Date("2026-05-09T05:00:00Z"));
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("skipped");
    expect(result.storiesInserted).toBe(0);
    expect(h.rolledBack()).toBe(true);
    expect(h.lastWatermarkUpdate()).toBeNull();
  });
});

describe("runLowslowSweep — finalization and watermark", () => {
  it("first run clamps to the latest window and finalizes an in-range beacon, advancing the watermark to H", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(null); // first run
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(1);
    expect(result.newWatermark).toEqual(horizon);
    expect(h.insertsMade()).toBe(1);
    expect(h.lastWatermarkUpdate()).toEqual(horizon);

    // First-run member-scan lower bound is H - 24h (slop-replay shape,
    // both bounds bound).
    const phase1 = h.queries.find(
      (q) =>
        q.sql.includes("FROM baseline_triaged_event") &&
        q.sql.includes("GROUP BY orig_addr"),
    );
    expect(phase1?.params?.[0]).toEqual(
      new Date(horizon.getTime() - 24 * HOUR),
    );
    expect(phase1?.params?.[1]).toEqual(horizon);
    // R6 binds the low-and-slow selector set (includes S3-recurring).
    expect(phase1?.params?.[2]).toEqual(
      expect.arrayContaining([
        "S2-severe",
        "unlabeled-cluster",
        "S3-recurring",
      ]),
    );
    expect(h.committed()).toBe(true);
  });

  it("advances the watermark to H even on a 0-Story run (progress watermark)", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(new Date("2026-05-09T04:00:00Z"));
    h.setCandidates([]); // nothing to finalize
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(0);
    expect(result.newWatermark).toEqual(horizon);
    expect(h.lastWatermarkUpdate()).toEqual(horizon);
  });

  it("does NOT finalize a cluster whose end is at-or-before the lowslow watermark (already-finalized contract)", async () => {
    const h = makeClient();
    // Watermark already past the beacon's end (03:15); a re-scan within
    // the 24h lookback must not re-insert.
    h.setHorizon(new Date("2026-05-09T06:00:00Z"));
    h.setLowslowWatermark(new Date("2026-05-09T04:00:00Z"));
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.storiesInserted).toBe(0);
    expect(h.insertsMade()).toBe(0);
    // Watermark still advances to H.
    expect(h.lastWatermarkUpdate()).toEqual(new Date("2026-05-09T06:00:00Z"));
  });
});

describe("runLowslowSweep — idempotency", () => {
  it("a suppressed event_group INSERT (ON CONFLICT DO NOTHING) does not count as a new story", async () => {
    const h = makeClient();
    h.setHorizon(new Date("2026-05-09T05:00:00Z"));
    h.setLowslowWatermark(null);
    h.setCandidates(beaconRows());
    h.suppressNextInsert();
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(0);
  });

  it("re-running over the same settled corpus (no cadence progress) inserts nothing via the H<=wm guard", async () => {
    // Round 1: first run, fires once, watermark → H.
    const h1 = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h1.setHorizon(horizon);
    h1.setLowslowWatermark(null);
    h1.setCandidates(beaconRows());
    hoisted.connect = () => h1.client;
    const r1 = await runLowslowSweep(1, {});
    expect(r1.storiesInserted).toBe(1);

    // Round 2: same corpus, cadence has not advanced (H unchanged),
    // lowslow watermark now == H → early-return, no scan, no insert.
    const h2 = makeClient();
    h2.setHorizon(horizon);
    h2.setLowslowWatermark(horizon);
    h2.setCandidates(beaconRows());
    hoisted.connect = () => h2.client;
    const r2 = await runLowslowSweep(1, {});
    expect(r2.storiesInserted).toBe(0);
    expect(h2.insertsMade()).toBe(0);
  });
});

describe("runLowslowSweep — recoverable late arrival (regression)", () => {
  it("finalizes a beacon whose late member cadence committed AFTER the lowslow watermark already advanced below it", async () => {
    // Round 1: cadence has settled only through 03:00. The late
    // member (04:15) is not yet in the corpus, so only 2 members are
    // visible → no R6. The watermark advances to 03:00.
    const early: FakeRow[] = beaconRows().slice(0, 2); // 01:05, 02:10
    const h1 = makeClient();
    h1.setHorizon(new Date("2026-05-09T03:00:00Z"));
    h1.setLowslowWatermark(null);
    h1.setCandidates(early);
    hoisted.connect = () => h1.client;
    const r1 = await runLowslowSweep(1, {});
    expect(r1.storiesInserted).toBe(0);
    expect(r1.newWatermark).toEqual(new Date("2026-05-09T03:00:00Z"));

    // Round 2: cadence has now committed the late row (event_time
    // 04:15) and advanced story_finalized_through to 05:00 — PAST the
    // lowslow watermark (03:00), which sits below that range. The
    // member-scan lookback [03:00 − 24h, 05:00] re-reads the full
    // beacon and finalizes it because its end (04:15) ∈ (03:00, 05:00].
    const late: FakeRow[] = [
      ...beaconRows().slice(0, 2),
      {
        event_key: "b-late",
        event_time: new Date("2026-05-09T04:15:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "COMMAND_AND_CONTROL",
        selector_tags: ["S3-recurring"],
        raw_score: 1.0,
      },
    ];
    const h2 = makeClient();
    h2.setHorizon(new Date("2026-05-09T05:00:00Z"));
    h2.setLowslowWatermark(new Date("2026-05-09T03:00:00Z"));
    h2.setCandidates(late);
    hoisted.connect = () => h2.client;
    const r2 = await runLowslowSweep(1, {});
    expect(r2.storiesInserted).toBe(1);
    expect(r2.newWatermark).toEqual(new Date("2026-05-09T05:00:00Z"));
  });
});
