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
  setCandidateScanError: (err: Error | null) => void;
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
  let candidateScanError: Error | null = null;
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
      // Simulate Postgres cancelling the 24h scan once
      // `statement_timeout` fires (SQLSTATE 57014).
      if (candidateScanError !== null) throw candidateScanError;
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
    setCandidateScanError: (err) => {
      candidateScanError = err;
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

describe("runLowslowSweep — R2 multi-stage low-and-slow (issue #702)", () => {
  // 3 events on one asset, 3 distinct critical categories in a
  // non-monotonic order, across 3 UTC hour buckets within 24h. The
  // caller picks the selector tags so a test can include or exclude the
  // R6 selector set independently of R2's category-only signal.
  function multiStageRows(selectorTags: string[]): FakeRow[] {
    return [
      {
        event_key: "s1",
        event_time: new Date("2026-05-09T01:05:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "INITIAL_ACCESS",
        selector_tags: selectorTags,
        raw_score: 1.0,
      },
      {
        event_key: "s2",
        event_time: new Date("2026-05-09T02:10:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "COMMAND_AND_CONTROL",
        selector_tags: selectorTags,
        raw_score: 1.0,
      },
      {
        event_key: "s3",
        event_time: new Date("2026-05-09T03:15:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "EXFILTRATION",
        selector_tags: selectorTags,
        raw_score: 1.0,
      },
    ];
  }

  function insertedRuleIds(h: FakeClientHandles): string[] {
    return h.queries
      .filter((q) => q.sql.includes("INSERT INTO event_group "))
      .map((q) => q.params?.[0] as string);
  }

  it("fires R2 for an oscillating multi-category asset (R6 selector absent)", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(null); // first run
    // No R6 selector overlap → R6 cannot fire; only R2's category-breadth
    // signal remains. The category order is non-monotonic
    // (INITIAL_ACCESS → C2 → EXFILTRATION here, but R2 is order-agnostic).
    h.setCandidates(multiStageRows([]));
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(1);
    expect(insertedRuleIds(h)).toEqual(["R2"]);
  });

  it("an asset satisfying both R2 and R6 produces both Stories (intended overlap)", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(null);
    // S3-recurring overlaps the R6 selector set AND the rows carry ≥3
    // distinct critical categories across ≥3 buckets, so R6 (persistent
    // repetition) and R2 (multi-stage breadth) both fire — two rows, one
    // per rule, per RFC §9 option A.
    h.setCandidates(multiStageRows(["S3-recurring"]));
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.status).toBe("ok");
    expect(result.storiesInserted).toBe(2);
    expect([...insertedRuleIds(h)].sort()).toEqual(["R2", "R6"]);
  });

  it("does NOT fire R2 for a single-category beacon (R6-only)", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(null);
    // beaconRows() carries one distinct category, below R2's
    // ≥3-distinct-category floor — only R6 fires.
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {});
    expect(result.storiesInserted).toBe(1);
    expect(insertedRuleIds(h)).toEqual(["R6"]);
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

describe("runLowslowSweep — DB-side timeout enforcement", () => {
  it("binds SET LOCAL statement_timeout (≤ budget) before the 24h member-scan when timeoutMs is supplied", async () => {
    const h = makeClient();
    const horizon = new Date("2026-05-09T05:00:00Z");
    h.setHorizon(horizon);
    h.setLowslowWatermark(null);
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, { timeoutMs: 60_000 });
    expect(result.status).toBe("ok");

    // A `SET LOCAL statement_timeout = <ms>` precedes the phase-1 scan,
    // so a stuck scan is bounded DB-side rather than only by the
    // dispatcher's AbortSignal (which client.query never observes).
    const scanIdx = h.queries.findIndex(
      (q) =>
        q.sql.includes("FROM baseline_triaged_event") &&
        q.sql.includes("GROUP BY orig_addr"),
    );
    expect(scanIdx).toBeGreaterThan(0);
    const setLocalBeforeScan = h.queries
      .slice(0, scanIdx)
      .reverse()
      .find((q) => /SET LOCAL statement_timeout\s*=\s*\d+/i.test(q.sql));
    expect(setLocalBeforeScan).toBeDefined();
    const boundMs = Number(
      /SET LOCAL statement_timeout\s*=\s*(\d+)/i.exec(
        setLocalBeforeScan?.sql ?? "",
      )?.[1],
    );
    expect(boundMs).toBeGreaterThan(0);
    expect(boundMs).toBeLessThanOrEqual(60_000);
  });

  it("issues NO statement_timeout binding when timeoutMs is omitted (unbounded direct call)", async () => {
    const h = makeClient();
    h.setHorizon(new Date("2026-05-09T05:00:00Z"));
    h.setLowslowWatermark(null);
    h.setCandidates(beaconRows());
    hoisted.connect = () => h.client;

    await runLowslowSweep(1, {});
    expect(
      h.queries.some((q) => /SET LOCAL statement_timeout/i.test(q.sql)),
    ).toBe(false);
  });

  it("rolls back and reports failed when the scan is cancelled by statement_timeout (57014), even if the abort signal was never observed", async () => {
    // The blocker case: the runner is stuck inside the 24h scan and the
    // AbortSignal is never seen mid-query. Postgres cancels the
    // statement (57014); the sweep must roll back and free the
    // connection + advisory lock — not hang the worker slot.
    const h = makeClient();
    h.setHorizon(new Date("2026-05-09T05:00:00Z"));
    h.setLowslowWatermark(null);
    h.setCandidates(beaconRows());
    const cancel = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    h.setCandidateScanError(cancel);
    // An already-aborted signal is deliberately ignored by the stuck
    // query path; enforcement comes from the DB-side cancel, not the
    // signal.
    const controller = new AbortController();
    hoisted.connect = () => h.client;

    const result = await runLowslowSweep(1, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/statement_timeout/i);
    expect(h.rolledBack()).toBe(true);
    expect(h.committed()).toBe(false);
    expect(h.lastWatermarkUpdate()).toBeNull();
  });
});
