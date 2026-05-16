import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
  CustomerNotFoundError: class extends Error {},
}));

// #573 wires `refresh_story_window` enqueue inside the rebuild
// transaction. These tests assert rebuild semantics (correlator,
// β carry-over, watermark invariant); mocking the Phase 2 helpers
// keeps them focused on rebuild behavior without forcing the mock
// pg client to answer aimer_push_queue / event_group SELECTs.
vi.mock("@/lib/aimer/phase2/state", () => ({
  enqueueNotice: vi.fn(async () => "fake-id"),
}));
vi.mock("@/lib/aimer/phase2/payload-builders", () => ({
  loadStoryRefreshRows: vi.fn(async () => []),
  buildStoryRefreshPayloads: vi.fn(() => ({
    payloads: [],
    warnings: [],
  })),
  logSubdivideWarnings: vi.fn(),
}));

import {
  _testing as rebuildTesting,
  runStoryRebuild,
  StoryRebuildBusyError,
  StoryRebuildInvalidRangeError,
} from "@/lib/triage/story/rebuild";
import { MAX_RULE_WINDOW_MS } from "@/lib/triage/story/rules";

interface CandidateRow {
  event_key: string;
  event_time: Date;
  kind: string;
  orig_addr: string | null;
  category: string | null;
  selector_tags: string[];
  raw_score: number;
}

interface SnapshotRow {
  correlation_rule_id: string | null;
  primary_asset: string | null;
  time_window_start: Date;
  time_window_end: Date;
  last_sent_at: Date | null;
  send_count: number;
  last_sent_by: string | null;
}

interface ClientHandles {
  client: unknown;
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  readonly released: boolean;
  insertedRows: Array<{
    params: unknown[];
    sql: string;
  }>;
  groupIds: string[];
  setCandidates(rows: CandidateRow[]): void;
  setSnapshot(rows: SnapshotRow[]): void;
  setCuratedCount(n: number): void;
  setDeletedCount(n: number): void;
  setLockAcquired(v: boolean): void;
  setWatermark(v: Date | null): void;
  watermarkUpdates(): Date[];
  /** Throw the provided error on the next `INSERT INTO event_group ` call. */
  failNextInsert(err: Error): void;
}

function makeClient(): ClientHandles {
  let candidates: CandidateRow[] = [];
  let snapshot: SnapshotRow[] = [];
  let curatedCount = 0;
  let deletedCount = 0;
  let lockAcquired = true;
  let nextGroupId = 1;
  let watermark: Date | null = null;
  let nextInsertFailure: Error | null = null;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const insertedRows: Array<{ params: unknown[]; sql: string }> = [];
  const groupIds: string[] = [];
  const watermarkUpdates: Date[] = [];
  let released = false;

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("BEGIN") || sql === "BEGIN") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("COMMIT") || sql === "COMMIT") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("ROLLBACK") || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM event_group") &&
      sql.includes("kind = 'analyst_curated'")
    ) {
      return { rows: [{ count: curatedCount }], rowCount: 1 };
    }
    if (
      sql.includes("FROM event_group") &&
      sql.includes("kind = 'auto_correlated'") &&
      !sql.includes("DELETE")
    ) {
      return { rows: snapshot, rowCount: snapshot.length };
    }
    if (sql.includes("DELETE FROM event_group")) {
      return { rows: [{ count: deletedCount }], rowCount: 1 };
    }
    if (sql.includes("UPDATE baseline_corpus_state")) {
      const v = params?.[0];
      if (v instanceof Date) watermarkUpdates.push(v);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM baseline_corpus_state")) {
      return {
        rows: [{ story_finalized_through: watermark }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM baseline_triaged_event")) {
      // Honor the SQL's event_time upper bound so a test can
      // simulate the rebuild's `endExclusive` candidate-scan
      // contract: when the SQL uses `event_time <` (rebuild) the
      // mock filters out events at-or-after the upper bound; when
      // it uses `event_time <=` (cadence) it includes them.
      const upperParam = sql.includes("event_time >= $1")
        ? params?.[1]
        : params?.[0];
      const upperIsExclusive = sql.includes("event_time < $");
      const upper = upperParam instanceof Date ? upperParam : null;
      const filtered =
        upper === null
          ? candidates
          : candidates.filter((c) =>
              upperIsExclusive
                ? c.event_time.getTime() < upper.getTime()
                : c.event_time.getTime() <= upper.getTime(),
            );
      return { rows: filtered, rowCount: filtered.length };
    }
    if (sql.includes("INSERT INTO event_group ")) {
      if (nextInsertFailure !== null) {
        const e = nextInsertFailure;
        nextInsertFailure = null;
        throw e;
      }
      const id = String(nextGroupId);
      nextGroupId += 1;
      groupIds.push(id);
      insertedRows.push({ params: params ?? [], sql });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO event_group_member")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const handles: ClientHandles = {
    client: {
      query,
      release() {
        released = true;
      },
    },
    queries,
    insertedRows,
    groupIds,
    get released() {
      return released;
    },
    setCandidates(rows: CandidateRow[]) {
      candidates = rows;
    },
    setSnapshot(rows: SnapshotRow[]) {
      snapshot = rows;
    },
    setCuratedCount(n: number) {
      curatedCount = n;
    },
    setDeletedCount(n: number) {
      deletedCount = n;
    },
    setLockAcquired(v: boolean) {
      lockAcquired = v;
    },
    setWatermark(v: Date | null) {
      watermark = v;
    },
    watermarkUpdates() {
      return watermarkUpdates;
    },
    failNextInsert(err: Error) {
      nextInsertFailure = err;
    },
  };
  return handles;
}

beforeEach(() => {
  mockGetCustomerPool.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function wireCustomerPool(client: unknown): void {
  mockGetCustomerPool.mockResolvedValue({
    connect: async () => client,
  });
}

const FROM = "2026-05-01T00:00:00.000Z";
const TO = "2026-05-08T00:00:00.000Z";

describe("runStoryRebuild — input validation", () => {
  it("rejects an empty range", async () => {
    const h = makeClient();
    wireCustomerPool(h.client);
    await expect(
      runStoryRebuild({
        customerId: 7,
        fromIso: FROM,
        toIso: FROM,
      }),
    ).rejects.toBeInstanceOf(StoryRebuildInvalidRangeError);
  });

  it("rejects an inverted range", async () => {
    const h = makeClient();
    wireCustomerPool(h.client);
    await expect(
      runStoryRebuild({
        customerId: 7,
        fromIso: TO,
        toIso: FROM,
      }),
    ).rejects.toBeInstanceOf(StoryRebuildInvalidRangeError);
  });
});

describe("runStoryRebuild — advisory lock", () => {
  it("throws StoryRebuildBusyError when the lock is held", async () => {
    const h = makeClient();
    h.setLockAcquired(false);
    wireCustomerPool(h.client);
    await expect(
      runStoryRebuild({
        customerId: 7,
        fromIso: FROM,
        toIso: TO,
      }),
    ).rejects.toBeInstanceOf(StoryRebuildBusyError);
    // Lock not held → no BEGIN issued; no unlock issued (we never
    // acquired); client released.
    const sql = h.queries.map((q) => q.sql);
    expect(sql.some((s) => s === "BEGIN")).toBe(false);
    expect(sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
  });

  it("releases the lock in the finally block on success", async () => {
    const h = makeClient();
    wireCustomerPool(h.client);
    await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    const sql = h.queries.map((q) => q.sql);
    expect(sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("releases the lock in the finally block on failure", async () => {
    const h = makeClient();
    h.setDeletedCount(0);
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-03T12:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-03T12:01:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "EXFILTRATION",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    h.failNextInsert(new Error("forced INSERT failure"));
    wireCustomerPool(h.client);
    await expect(
      runStoryRebuild({
        customerId: 7,
        fromIso: FROM,
        toIso: TO,
      }),
    ).rejects.toThrow("forced INSERT failure");
    const sql = h.queries.map((q) => q.sql);
    expect(sql.some((s) => s === "ROLLBACK")).toBe(true);
    expect(sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });
});

describe("runStoryRebuild — transactional boundary", () => {
  it("opens a transaction before DELETE and rolls back on insert failure", async () => {
    const h = makeClient();
    h.setCandidates([
      {
        event_key: "1",
        event_time: new Date("2026-05-03T12:00:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "2",
        event_time: new Date("2026-05-03T12:01:00Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "EXFILTRATION",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    h.failNextInsert(new Error("constraint violation"));
    wireCustomerPool(h.client);
    await expect(
      runStoryRebuild({
        customerId: 7,
        fromIso: FROM,
        toIso: TO,
      }),
    ).rejects.toThrow("constraint violation");
    const order = h.queries.map((q) => q.sql);
    const beginIdx = order.indexOf("BEGIN");
    const deleteIdx = order.findIndex((s) =>
      s.includes("DELETE FROM event_group"),
    );
    const rollbackIdx = order.indexOf("ROLLBACK");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(beginIdx);
    expect(rollbackIdx).toBeGreaterThan(deleteIdx);
    // No COMMIT issued.
    expect(order.some((s) => s === "COMMIT")).toBe(false);
  });
});

describe("runStoryRebuild — window contract", () => {
  it("DELETE is filtered to kind='auto_correlated' AND [from, to) on time_window_end", async () => {
    const h = makeClient();
    h.setDeletedCount(4);
    wireCustomerPool(h.client);
    await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    const deleteQ = h.queries.find((q) =>
      q.sql.includes("DELETE FROM event_group"),
    );
    expect(deleteQ).toBeDefined();
    expect(deleteQ?.sql).toContain("kind = 'auto_correlated'");
    expect(deleteQ?.sql).toContain("time_window_end >= $1");
    expect(deleteQ?.sql).toContain("time_window_end < $2");
    expect(deleteQ?.params).toEqual([new Date(FROM), new Date(TO)]);
  });

  it("reports skippedCuratedStories from the curated-count SELECT", async () => {
    const h = makeClient();
    h.setCuratedCount(3);
    h.setDeletedCount(0);
    wireCustomerPool(h.client);
    const result = await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    expect(result.skippedCuratedStories).toBe(3);
    expect(result.deletedAutoStories).toBe(0);
  });

  it("member-scan reaches back MAX_RULE_WINDOW_MS before from", async () => {
    const h = makeClient();
    wireCustomerPool(h.client);
    await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    const scanQueries = h.queries.filter((q) =>
      q.sql.includes("FROM baseline_triaged_event"),
    );
    // R1 + R3 phase 1 + (R3 phase 2 only when phase 1 returned
    // assets; the empty fake yields []).
    expect(scanQueries.length).toBeGreaterThanOrEqual(2);
    const expectedStart = new Date(
      new Date(FROM).getTime() - MAX_RULE_WINDOW_MS,
    );
    const expectedEnd = new Date(TO);
    for (const q of scanQueries) {
      // Lower-bound parameter is the member-scan start; upper is
      // `to`. The repository read functions take `(start, end, ...)`.
      expect(q.params?.[0]).toEqual(expectedStart);
      expect(q.params?.[1]).toEqual(expectedEnd);
    }
  });

  it("only finalizes drafts whose time_window_end is strictly inside [from, to)", async () => {
    const h = makeClient();
    // Three R3 clusters (asset 10.0.0.5 with three S2-severe events
    // each within 1h):
    //   cluster A: ends at 2026-04-30T23:59:00Z (before `from`).
    //   cluster B: ends at 2026-05-03T12:00:00Z (inside the window).
    //   cluster C: ends at 2026-05-08T00:00:00.000Z == to (excluded).
    // We construct three distinct assets so each cluster is per-asset.
    const mkR3 = (
      asset: string,
      end: string,
      keys: string[],
    ): CandidateRow[] => {
      const endMs = new Date(end).getTime();
      return keys.map((k, idx) => ({
        event_key: k,
        event_time: new Date(endMs - (keys.length - 1 - idx) * 60_000),
        kind: "HttpThreat",
        orig_addr: asset,
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      }));
    };
    h.setCandidates([
      ...mkR3("10.0.0.1", "2026-04-30T23:59:00Z", ["a1", "a2", "a3"]),
      ...mkR3("10.0.0.2", "2026-05-03T12:00:00Z", ["b1", "b2", "b3"]),
      ...mkR3("10.0.0.3", "2026-05-08T00:00:00.000Z", ["c1", "c2", "c3"]),
    ]);
    wireCustomerPool(h.client);
    const result = await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    // Only the in-range cluster B gets INSERTed.
    expect(result.insertedAutoStories).toBe(1);
    expect(h.insertedRows).toHaveLength(1);
    // The INSERT corresponds to asset 10.0.0.2.
    expect(h.insertedRows[0].params).toContain("10.0.0.2");
  });
});

describe("runStoryRebuild — member-scan upper bound is exclusive at `to`", () => {
  it("excludes events at exactly `to` so an in-window cluster is not absorbed into a draft ending at `to`", async () => {
    // Regression for the half-open contract: with an inclusive
    // upper bound, R3 same-asset events at `to-60m`, `to-30m`,
    // `to-1m`, `to` cluster into one draft ending at `to`. The
    // finalize predicate `endMs < to` then drops it, and the
    // pre-rebuild Story whose `time_window_end == to-1m` (already
    // DELETEd by the rebuild) is never reinserted — a silently-
    // lost Story inside the requested window. With the exclusive
    // upper bound, the event at `to` stays out of the candidate
    // set; the remaining three events form a cluster ending at
    // `to-1m`, which the finalize predicate accepts.
    const h = makeClient();
    const toMs = new Date(TO).getTime();
    const at = (offsetMs: number) => new Date(toMs - offsetMs);
    h.setCandidates([
      {
        event_key: "k1",
        event_time: at(60 * 60_000),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "k2",
        event_time: at(30 * 60_000),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "k3",
        event_time: at(60_000),
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "k4",
        event_time: at(0), // exactly `to`
        kind: "HttpThreat",
        orig_addr: "10.0.0.5",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    wireCustomerPool(h.client);
    const result = await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    expect(result.insertedAutoStories).toBe(1);
    expect(h.insertedRows).toHaveLength(1);
    // The candidate-scan SQL uses the exclusive operator.
    const scanQueries = h.queries.filter((q) =>
      q.sql.includes("FROM baseline_triaged_event"),
    );
    expect(scanQueries.length).toBeGreaterThan(0);
    for (const q of scanQueries) {
      expect(q.sql).toMatch(/event_time < \$/);
      expect(q.sql).not.toMatch(/event_time <= \$/);
    }
    // The INSERTed draft's `time_window_end` is `to - 1min`, not
    // `to` — proving the event at exactly `to` did not extend the
    // cluster.
    const params = h.insertedRows[0].params;
    const ends = params.filter((p): p is Date => p instanceof Date);
    expect(ends.some((d) => d.getTime() === toMs - 60_000)).toBe(true);
    expect(ends.some((d) => d.getTime() === toMs)).toBe(false);
  });
});

describe("runStoryRebuild — β carry-over", () => {
  it("copies β columns when the natural key matches", async () => {
    const h = makeClient();
    const lastSentAt = new Date("2026-05-02T00:00:00Z");
    const lastSentBy = "00000000-0000-0000-0000-000000000001";
    // Snapshot of a pre-rebuild auto Story matching the cluster
    // below on (rule, asset, start, end).
    h.setSnapshot([
      {
        correlation_rule_id: "R3",
        primary_asset: "10.0.0.2",
        time_window_start: new Date("2026-05-03T11:58:00.000Z"),
        time_window_end: new Date("2026-05-03T12:00:00.000Z"),
        last_sent_at: lastSentAt,
        send_count: 2,
        last_sent_by: lastSentBy,
      },
    ]);
    h.setDeletedCount(1);
    h.setCandidates([
      {
        event_key: "b1",
        event_time: new Date("2026-05-03T11:58:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b2",
        event_time: new Date("2026-05-03T11:59:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b3",
        event_time: new Date("2026-05-03T12:00:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    wireCustomerPool(h.client);
    const result = await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    expect(result.insertedAutoStories).toBe(1);
    expect(result.betaCarriedOver).toBe(1);
    expect(h.insertedRows).toHaveLength(1);
    const ins = h.insertedRows[0];
    // β-aware INSERT path lists the β columns and binds them.
    expect(ins.sql).toContain("last_sent_at");
    expect(ins.sql).toContain("send_count");
    expect(ins.sql).toContain("last_sent_by");
    expect(ins.params).toContain(lastSentAt);
    expect(ins.params).toContain(2);
    expect(ins.params).toContain(lastSentBy);
  });

  it("writes NULL / 0 / NULL when the natural key does not match", async () => {
    const h = makeClient();
    // Snapshot exists but for a DIFFERENT asset.
    h.setSnapshot([
      {
        correlation_rule_id: "R3",
        primary_asset: "10.0.0.99",
        time_window_start: new Date("2026-05-03T11:58:00.000Z"),
        time_window_end: new Date("2026-05-03T12:00:00.000Z"),
        last_sent_at: new Date("2026-05-02T00:00:00Z"),
        send_count: 5,
        last_sent_by: "00000000-0000-0000-0000-000000000099",
      },
    ]);
    h.setCandidates([
      {
        event_key: "b1",
        event_time: new Date("2026-05-03T11:58:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b2",
        event_time: new Date("2026-05-03T11:59:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b3",
        event_time: new Date("2026-05-03T12:00:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    wireCustomerPool(h.client);
    const result = await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    expect(result.insertedAutoStories).toBe(1);
    expect(result.betaCarriedOver).toBe(0);
    expect(h.insertedRows).toHaveLength(1);
    // β-free INSERT — no β columns in the column list.
    const sql = h.insertedRows[0].sql;
    expect(sql).not.toContain("last_sent_at");
    expect(sql).not.toContain("send_count");
    expect(sql).not.toContain("last_sent_by");
  });
});

describe("runStoryRebuild — watermark invariant", () => {
  it("never reads or writes baseline_corpus_state.story_finalized_through", async () => {
    const h = makeClient();
    const watermark = new Date("2026-05-05T00:00:00Z");
    h.setWatermark(watermark);
    h.setCandidates([
      {
        event_key: "b1",
        event_time: new Date("2026-05-03T11:58:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b2",
        event_time: new Date("2026-05-03T11:59:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
      {
        event_key: "b3",
        event_time: new Date("2026-05-03T12:00:00.000Z"),
        kind: "HttpThreat",
        orig_addr: "10.0.0.2",
        category: "IMPACT",
        selector_tags: ["S2-severe"],
        raw_score: 1.5,
      },
    ]);
    wireCustomerPool(h.client);
    await runStoryRebuild({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
    // No SELECT against baseline_corpus_state; no UPDATE.
    const touchesState = h.queries.filter(
      (q) =>
        q.sql.includes("baseline_corpus_state") &&
        !q.sql.includes("pg_try_advisory_lock") &&
        !q.sql.includes("pg_advisory_unlock"),
    );
    expect(touchesState).toEqual([]);
    expect(h.watermarkUpdates()).toEqual([]);
  });
});

describe("_testing — snapshot/draft key", () => {
  it("snapshotKey and draftKey collapse to the same string for matching values", () => {
    const start = new Date("2026-05-03T11:58:00.000Z");
    const end = new Date("2026-05-03T12:00:00.000Z");
    expect(rebuildTesting.snapshotKey("R3", "10.0.0.2", start, end)).toBe(
      rebuildTesting.draftKey({
        ruleId: "R3",
        primaryAsset: "10.0.0.2",
        timeWindowStart: start,
        timeWindowEnd: end,
        members: [],
        score: 0,
        summary: {
          kindHistogram: {},
          categoryHistogram: {},
          memberCount: 0,
          durationMs: 0,
          distinctAssetCount: 0,
          topRawScore: 0,
        },
      }),
    );
  });
});
