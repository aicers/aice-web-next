import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockResolveActive = vi.hoisted(() =>
  vi.fn(async (_customerId: number) => ({
    rules: [],
    fingerprint: "empty",
  })),
);

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
  CustomerNotFoundError: class extends Error {},
}));

vi.mock("@/lib/triage/exclusion/active-set-storage", () => ({
  STORAGE_EXCLUSION_SET_RESOLVER: {
    resolve: (customerId: number) => mockResolveActive(customerId),
  },
}));

vi.mock("@/lib/triage/exclusion", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage/exclusion")>(
    "@/lib/triage/exclusion",
  );
  return {
    ...actual,
    computeExclusionsFingerprint: vi.fn(() => "fp-empty"),
  };
});

vi.mock("@/lib/triage/story/correlator", () => ({
  runStepF: vi.fn().mockResolvedValue(undefined),
}));

// #573 wires `refresh_baseline_window` enqueue inside the rebuild
// transaction. These tests assert rebuild semantics (DELETE/INSERT,
// timing, lock release); mocking the Phase 2 helpers keeps them
// focused on rebuild behavior without forcing every mock pg client
// to answer queue / source-row SELECTs.
vi.mock("@/lib/aimer/phase2/state", () => ({
  enqueueNotice: vi.fn(async () => "fake-id"),
}));
vi.mock("@/lib/aimer/phase2/payload-builders", () => ({
  loadBaselineRefreshRows: vi.fn(async () => ({
    events: [],
    baselineVersion: null,
    baselineVersions: [],
  })),
  buildBaselineRefreshPayloads: vi.fn(() => ({
    payloads: [],
    warnings: [],
  })),
  logSubdivideWarnings: vi.fn(),
}));

vi.mock("@/lib/triage/baseline/selectors", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/baseline/selectors")
  >("@/lib/triage/baseline/selectors");
  return {
    ...actual,
    // `detectActiveWindows` returns a `Set<StatisticsWindowDays>` in
    // production. An empty Set keeps the scorer in the no-active-window
    // branch (all per-window contributions zero) without bypassing the
    // production code path that consumes the result.
    detectActiveWindows: vi.fn().mockResolvedValue(new Set()),
    scoreSelectorsForPage: vi.fn().mockResolvedValue(new Map()),
  };
});

interface MockClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  released: boolean;
  query: ReturnType<typeof vi.fn>;
  release: () => void;
}

function createMockClient(lockAcquired: boolean): MockClient {
  const client: MockClient = {
    queries: [],
    released: false,
    query: vi.fn(),
    // Match `pg`'s real pool client: a second `release()` throws.
    // The test suite uses this to guard against a regression where
    // a busy/timeout path double-releases and masks the original
    // typed error.
    release() {
      if (client.released) {
        throw new Error("Release called more than once.");
      }
      client.released = true;
    },
  };

  client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    client.queries.push({ sql, params });
    if (sql.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      return { rows: [], rowCount: 0 };
    }
    // DELETE...RETURNING wrapper returns a count
    if (sql.includes("DELETE FROM baseline_triaged_event")) {
      return { rows: [{ count: 3 }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM observed_event_meta")) {
      return { rows: [{ count: 5 }], rowCount: 1 };
    }
    // INSERT into baseline_corpus_state
    if (sql.includes("baseline_corpus_state")) {
      return { rows: [], rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK
    return { rows: [], rowCount: 0 };
  });
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runTriageBaselineRebuild", () => {
  beforeEach(() => {
    mockGetCustomerPool.mockReset();
    mockResolveActive.mockClear();
  });

  it("throws RebuildBusyError when the advisory lock is unavailable", async () => {
    const client = createMockClient(false);
    mockGetCustomerPool.mockResolvedValue({
      connect: async () => client,
    });
    const { runTriageBaselineRebuild, RebuildBusyError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 1,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(RebuildBusyError);
    // The client should be released even on the busy path.
    expect(client.released).toBe(true);
  });

  it("uses the byte-identical lock key as cadence", async () => {
    const client = createMockClient(false);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 42,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    const lockCall = client.queries.find((q) =>
      q.sql.includes("pg_try_advisory_lock"),
    );
    expect(lockCall).toBeDefined();
    expect(lockCall?.params).toEqual(["triage_baseline_cadence:42"]);
  });

  it("runs DELETE + reinsert + UPDATE corpus state when lock acquired and review is empty", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    const result = await runTriageBaselineRebuild({
      customerId: 42,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    expect(result.deletedTriagedRows).toBe(3);
    expect(result.deletedObservedRows).toBe(5);
    expect(result.insertedTriagedRows).toBe(0);
    expect(result.insertedObservedRows).toBe(0);
    expect(result.warnings).toContain(
      "review returned 0 events in range; corpus is now empty for [from, to)",
    );
    // last_rebuild_at UPDATE was issued.
    const stateUpdate = client.queries.find((q) =>
      q.sql.includes("baseline_corpus_state"),
    );
    expect(stateUpdate).toBeDefined();
    // The fetch carried `start` / `end` from the input range.
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({
          filter: expect.objectContaining({
            customers: ["42"],
            start: "2026-01-01T00:00:00.000Z",
            end: "2026-01-02T00:00:00.000Z",
          }),
        }),
      }),
    );
    // BEGIN + COMMIT bracket the DELETE/INSERT block.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("COMMIT");
  });

  it("captures completedAt after the advisory unlock + client.release() so durationMs covers the full lock-held window (P2 round 8)", async () => {
    // Round 8 P2: the audit row's `completedAt` and the result's
    // `durationMs` must mark the rebuild done at the lock-release
    // boundary, not earlier. Previously the timestamps were captured
    // inside the `try` block (before the `finally` issued
    // `pg_advisory_unlock` + `client.release()`), so the audit
    // window under-reported by the unlock latency and could mark
    // the rebuild "done" while cadence / exclusion-ADD were still
    // blocked on the shared advisory key. Pin the post-finally
    // capture by recording the wall-clock at each side-effect and
    // asserting `completedAtIso` is not earlier than the unlock /
    // release timestamps.
    const client = createMockClient(true);
    const timeline: { unlockAt: number | null; releaseAt: number | null } = {
      unlockAt: null,
      releaseAt: null,
    };
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        timeline.unlockAt = Date.now();
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM baseline_triaged_event")) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM observed_event_meta")) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const originalRelease = client.release.bind(client);
    client.release = () => {
      timeline.releaseAt = Date.now();
      originalRelease();
    };
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    const result = await runTriageBaselineRebuild({
      customerId: 7,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    const { unlockAt, releaseAt } = timeline;
    if (unlockAt === null || releaseAt === null) {
      throw new Error(
        "expected `pg_advisory_unlock` + `client.release()` to have run",
      );
    }
    const completedAt = Date.parse(result.completedAtIso);
    expect(Number.isFinite(completedAt)).toBe(true);
    // `completedAtIso` is captured after the `finally` has run
    // `pg_advisory_unlock` and `client.release()`.
    expect(completedAt).toBeGreaterThanOrEqual(unlockAt);
    expect(completedAt).toBeGreaterThanOrEqual(releaseAt);
    // `durationMs` covers the full lock-held window: it must be at
    // least as large as the unlock timestamp minus `startedAt`
    // (derived from `startedAtIso`).
    const startedAt = Date.parse(result.startedAtIso);
    expect(result.durationMs).toBeGreaterThanOrEqual(unlockAt - startedAt);
  });

  it("releases the advisory lock on the success path", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 7,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    const unlockCall = client.queries.find((q) =>
      q.sql.includes("pg_advisory_unlock"),
    );
    expect(unlockCall).toBeDefined();
    expect(client.released).toBe(true);
  });

  it("rolls back and skips last_rebuild_at when a write inside the transaction fails", async () => {
    const client = createMockClient(true);
    // Force the DELETE inside the transaction to error so we exercise
    // the rollback path. The advisory lock has already been acquired
    // at this point, so this also covers lock-release on failure.
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM baseline_triaged_event")) {
        throw new Error("simulated constraint violation");
      }
      return { rows: [], rowCount: 0 };
    });
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 99,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        testOverrides: { fetchPage },
      }),
    ).rejects.toThrow("simulated constraint violation");

    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).toContain("BEGIN");
    // ROLLBACK was issued, COMMIT was not.
    expect(sqls.some((s) => s.includes("ROLLBACK"))).toBe(true);
    expect(sqls).not.toContain("COMMIT");
    // baseline_corpus_state.last_rebuild_at is NOT advanced.
    expect(sqls.some((s) => s.includes("baseline_corpus_state"))).toBe(false);
    // The advisory lock is still released and the client is returned to the pool.
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("releases the lock and client when the transaction throws after lock acquisition", async () => {
    const client = createMockClient(true);
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("BEGIN")) {
        throw new Error("connection dropped");
      }
      return { rows: [], rowCount: 0 };
    });
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 11,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        testOverrides: { fetchPage },
      }),
    ).rejects.toThrow("connection dropped");
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("issues SET LOCAL statement_timeout inside the rebuild transaction", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 21,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    // BEGIN is followed by SET LOCAL statement_timeout before the
    // first DELETE, so the 300s wall-clock cap is enforced inside
    // the write transaction rather than only after it returns.
    const sqls = client.queries.map((q) => q.sql);
    const beginIdx = sqls.indexOf("BEGIN");
    const setLocalIdx = sqls.findIndex((s) =>
      /SET LOCAL statement_timeout\s*=\s*\d+/i.test(s),
    );
    const deleteIdx = sqls.findIndex((s) =>
      s.includes("DELETE FROM baseline_triaged_event"),
    );
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(setLocalIdx).toBeGreaterThan(beginIdx);
    expect(setLocalIdx).toBeLessThan(deleteIdx);
  });

  it("converts statement_timeout (SQLSTATE 57014) to RebuildTimeoutError", async () => {
    const client = createMockClient(true);
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM baseline_triaged_event")) {
        const err = new Error(
          "canceling statement due to statement timeout",
        ) as Error & { code?: string };
        err.code = "57014";
        throw err;
      }
      return { rows: [], rowCount: 0 };
    });
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild, RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 22,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        testOverrides: { fetchPage },
      }),
    ).rejects.toBeInstanceOf(RebuildTimeoutError);
    const sqls = client.queries.map((q) => q.sql);
    // Rolled back, lock released, client returned.
    expect(sqls.some((s) => s.includes("ROLLBACK"))).toBe(true);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("throws RebuildIncompleteError when the resolver never exhausts the range", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    // Always reports hasNextPage = true with an advancing cursor.
    let callCount = 0;
    const fetchPage = vi.fn().mockImplementation(async () => {
      callCount += 1;
      return {
        eventListWithTriage: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: true,
            startCursor: null,
            endCursor: `cursor-${callCount}`,
          },
          edges: [],
        },
      };
    });
    const { runTriageBaselineRebuild, RebuildIncompleteError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 33,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        testOverrides: { fetchPage },
      }),
    ).rejects.toBeInstanceOf(RebuildIncompleteError);
    // No transaction was opened — DELETE never ran, last_rebuild_at
    // is not advanced. The lock is released and the client returned.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).not.toContain("BEGIN");
    expect(
      sqls.some((s) => s.includes("DELETE FROM baseline_triaged_event")),
    ).toBe(false);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("throws RebuildIncompleteError when hasNextPage=true but endCursor is null", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: true,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild, RebuildIncompleteError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 34,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        testOverrides: { fetchPage },
      }),
    ).rejects.toBeInstanceOf(RebuildIncompleteError);
    // The corpus must be untouched: no BEGIN, no DELETE, no
    // last_rebuild_at advance. The advisory lock is still released.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).not.toContain("BEGIN");
    expect(
      sqls.some((s) => s.includes("DELETE FROM baseline_triaged_event")),
    ).toBe(false);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("re-binds statement_timeout before every transaction statement (cumulative cap)", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    // Return one non-empty page so the transaction runs through both
    // DELETEs, at least one processFetchedPage call, and the UPDATE.
    // The page's `edges` are empty so processFetchedPage does not
    // attempt any extra SQL beyond what the test mock returns.
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 91,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    // `SET LOCAL statement_timeout = <ms>` must precede *each* of the
    // two DELETEs, the per-page iteration, and the corpus-state
    // UPDATE — Postgres' `statement_timeout` resets per-statement,
    // so the 300 s cumulative cap is only enforced by re-binding the
    // remaining budget before every statement.
    const sqls = client.queries.map((q) => q.sql);
    const setLocalCount = sqls.filter((s) =>
      /SET LOCAL statement_timeout\s*=\s*\d+/i.test(s),
    ).length;
    // Two DELETEs + one per-page SET + one UPDATE = at least 4.
    expect(setLocalCount).toBeGreaterThanOrEqual(4);
    // Each DELETE / the UPDATE is immediately preceded by a SET LOCAL.
    const deleteTriagedIdx = sqls.findIndex((s) =>
      s.includes("DELETE FROM baseline_triaged_event"),
    );
    expect(deleteTriagedIdx).toBeGreaterThan(0);
    expect(sqls[deleteTriagedIdx - 1]).toMatch(/SET LOCAL statement_timeout/i);
    const deleteObservedIdx = sqls.findIndex((s) =>
      s.includes("DELETE FROM observed_event_meta"),
    );
    expect(deleteObservedIdx).toBeGreaterThan(0);
    expect(sqls[deleteObservedIdx - 1]).toMatch(/SET LOCAL statement_timeout/i);
    const updateIdx = sqls.findIndex((s) =>
      s.includes("baseline_corpus_state"),
    );
    expect(updateIdx).toBeGreaterThan(0);
    expect(sqls[updateIdx - 1]).toMatch(/SET LOCAL statement_timeout/i);
  });

  it("re-binds statement_timeout before every page-helper INSERT (covers SQL inside processFetchedPage)", async () => {
    // Regression for Round 3 P1: with empty `edges`, the page helper
    // issues no SQL and the test cannot prove the cumulative cap covers
    // the helper-internal statements (resolver, observed/baseline
    // INSERTs, active-windows SELECT, selector scoring SELECT). Feeding
    // a non-empty edge ensures the helper actually calls
    // `client.query()` for both batched INSERTs, so the assertion below
    // proves the deadline-bound client wrapper re-binds
    // `statement_timeout` before *each* of those round-trips — not just
    // before the DELETEs / UPDATE that bracket the helper.
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: "1",
          endCursor: "1",
        },
        edges: [
          {
            cursor: "1",
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "COMMAND_AND_CONTROL",
              level: "MEDIUM",
              confidence: 0.9,
              origAddr: "10.0.0.1",
              respAddr: "1.1.1.1",
              origPort: 50000,
              respPort: 443,
              host: "phish.example",
              uri: "/login",
              clusterId: "",
            },
          },
        ],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 92,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    const sqls = client.queries.map((q) => q.sql);
    // The observed-meta and baseline INSERTs both ran (one edge in).
    const observedInsertIdx = sqls.findIndex((s) =>
      s.includes("INSERT INTO observed_event_meta"),
    );
    const baselineInsertIdx = sqls.findIndex((s) =>
      s.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(observedInsertIdx).toBeGreaterThan(0);
    expect(baselineInsertIdx).toBeGreaterThan(observedInsertIdx);
    // Each helper-internal INSERT is *immediately* preceded by a
    // `SET LOCAL statement_timeout` issued by the deadline-bound
    // client wrapper. Round 3 P1 specifically: the previous code only
    // bound the timeout once before processFetchedPage, so every
    // helper-internal statement inherited the same (stale) budget —
    // a single page could now spend `N × statement_timeout`. The
    // wrapper re-binds the *remaining* budget before each query so
    // the 300 s cap is cumulative across helper internals.
    expect(sqls[observedInsertIdx - 1]).toMatch(/SET LOCAL statement_timeout/i);
    expect(sqls[baselineInsertIdx - 1]).toMatch(/SET LOCAL statement_timeout/i);
  });

  it("pre-resolves the active exclusion set once outside the transaction", async () => {
    // Round 3 P1: the storage resolver issues two SELECTs on a separate
    // pool connection (`global_triage_exclusion`, `triage_exclusion`),
    // so the rebuild client's `SET LOCAL statement_timeout` cannot
    // govern them. Pre-resolving once outside the transaction confines
    // the uncoverable separate-connection SQL to a single round-trip
    // (and pins the active set across every page of the rebuild — so
    // an exclusion-ADD landing mid-fetch does not produce a drifting
    // `exclusions_fp` between pages of one rebuild).
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    let pageCount = 0;
    const fetchPage = vi.fn().mockImplementation(async () => {
      pageCount += 1;
      return {
        eventListWithTriage: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: pageCount < 3,
            startCursor: `c${pageCount}`,
            endCursor: `c${pageCount}`,
          },
          edges: [],
        },
      };
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 93,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    // Three pages fetched, but the storage resolver was called exactly
    // once — not per page.
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(mockResolveActive).toHaveBeenCalledTimes(1);
  });

  it("resolves the exclusion set after acquiring the advisory lock (P1 round 5)", async () => {
    // Round 5 P1: doing the resolve before the lock leaves a window in
    // which a concurrent exclusion-ADD can commit, after which the
    // rebuild's DELETE + re-INSERT would use the stale pre-ADD
    // exclusion set and reintroduce rows the ADD was meant to remove.
    // The fix orders the resolve **after** the lock so the snapshot is
    // observed inside the same held-lock region as the DELETE/INSERT
    // chain, and any concurrent exclusion-ADD attempt waits for the
    // rebuild to release the lock. The deadline-race in
    // `resolveActiveExclusionsWithDeadline` keeps the wall-clock cap
    // intact even though a stuck SELECT can no longer be aborted by
    // releasing the lock prematurely.
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const callOrder: string[] = [];
    mockResolveActive.mockImplementationOnce(async () => {
      callOrder.push("resolve");
      return { rules: [], fingerprint: "empty" };
    });
    const originalQuery = client.query.getMockImplementation() as (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; rowCount: number }>;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_try_advisory_lock")) {
        callOrder.push("lock");
      }
      return originalQuery(sql, params);
    });
    const fetchPage = vi.fn().mockResolvedValue({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    });
    const { runTriageBaselineRebuild } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await runTriageBaselineRebuild({
      customerId: 94,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-01-02T00:00:00.000Z",
      testOverrides: { fetchPage },
    });
    // The exclusion resolve must run after the lock acquisition so the
    // snapshot is observed inside the held-lock region.
    expect(callOrder[0]).toBe("lock");
    expect(callOrder[1]).toBe("resolve");
  });

  it("times out the exclusion resolve and releases the advisory lock (P1 round 5)", async () => {
    // Round 5 P1: a stuck storage resolver must not hold the rebuild
    // past the 300 s cap. The resolve now runs **after** lock
    // acquisition, so when the deadline-bound race fires the `finally`
    // block must release the lock so cadence / exclusion-ADD become
    // un-blocked within the budget.
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn();
    const { runTriageBaselineRebuild, RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    // Push Date.now past the rebuild's deadline so the JS-side
    // remaining-ms check inside `resolveActiveExclusionsWithDeadline`
    // fires after the lock is acquired but before any fetch work runs.
    const realNow = Date.now.bind(Date);
    let callIdx = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      callIdx += 1;
      // First call (`startedAt`) returns wall-clock; subsequent calls
      // (used to compute `remainingMs`) report past the 300 s deadline.
      return callIdx === 1 ? realNow() : realNow() + 300_001;
    });
    try {
      await expect(
        runTriageBaselineRebuild({
          customerId: 95,
          fromIso: "2026-01-01T00:00:00.000Z",
          toIso: "2026-01-02T00:00:00.000Z",
          testOverrides: { fetchPage },
        }),
      ).rejects.toBeInstanceOf(RebuildTimeoutError);
    } finally {
      dateSpy.mockRestore();
    }
    // Fetcher never ran; lock was acquired and then released; client
    // returned to the pool.
    expect(fetchPage).not.toHaveBeenCalled();
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes("pg_try_advisory_lock"))).toBe(true);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("aborts the fetch loop when the input signal is already aborted", async () => {
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const fetchPage = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { runTriageBaselineRebuild, RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 17,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        signal: controller.signal,
        testOverrides: { fetchPage },
      }),
    ).rejects.toBeInstanceOf(RebuildTimeoutError);
    // Fetcher must not have been invoked once the abort was observed.
    expect(fetchPage).not.toHaveBeenCalled();
    // Lock acquired in this test (createMockClient(true)); unlock must
    // be issued and the client must be returned to the pool.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("maps an in-flight fetch abort caused by the hard timeout to RebuildTimeoutError (P1 round 6)", async () => {
    // Round 6 P1: the previous fetch-loop guard only checked
    // `signal.aborted` **before** each round-trip. If the 300 s hard
    // timer fired while `fetchEventPage` / `graphqlRequest` was already
    // mid-flight, the underlying fetch rejected with an `AbortError`
    // that propagated up untyped, hitting the route handler's
    // fallthrough `throw err` and surfacing as a generic 500 instead of
    // the contractual `{ code: "RebuildTimeout" }` (504). This test
    // pins the normalisation behaviour: the fetcher rejects with an
    // AbortError *after* the rebuild's deadline has lapsed, and the
    // runtime must convert it into a typed RebuildTimeoutError.
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    // Drive `Date.now` past the 300 s deadline on the second call so
    // the JS-side `Date.now() > deadline` check in the catch arm fires
    // and triggers the normalisation. The first call (`startedAt`)
    // returns wall-clock so the deadline is initialised correctly.
    const realNow = Date.now.bind(Date);
    let callIdx = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      callIdx += 1;
      // Calls in order under the rebuild path:
      //   1. `startedAt = Date.now()`
      //   2. `remainingMs = deadline - Date.now()` inside
      //      `resolveActiveExclusionsWithDeadline`
      //   3. `Date.now() > deadline` inside the fetch loop, immediately
      //      before the fetcher is invoked
      // All three must observe wall-clock so the pre-fetch guards do
      // not short-circuit. Call 4 (`Date.now() > deadline` in the
      // catch arm) is the one that needs to land past the deadline so
      // the AbortError is normalised to RebuildTimeoutError.
      return callIdx <= 3 ? realNow() : realNow() + 300_001;
    });
    // Fetcher rejects mid-flight with a DOMException-shaped AbortError
    // — exactly the shape `undici` / `graphql-request` throw when the
    // abort signal fires during an in-flight `fetch`.
    const abortError: Error & { code?: string } = Object.assign(
      new Error("The operation was aborted."),
      { name: "AbortError", code: "ABORT_ERR" },
    );
    const fetchPage = vi.fn().mockRejectedValue(abortError);
    const { runTriageBaselineRebuild, RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    try {
      await expect(
        runTriageBaselineRebuild({
          customerId: 71,
          fromIso: "2026-01-01T00:00:00.000Z",
          toIso: "2026-01-02T00:00:00.000Z",
          testOverrides: { fetchPage },
        }),
      ).rejects.toBeInstanceOf(RebuildTimeoutError);
    } finally {
      dateSpy.mockRestore();
    }
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const sqls = client.queries.map((q) => q.sql);
    // The lock was acquired before the fetch was attempted, so the
    // unlock must be issued and the client returned to the pool — no
    // BEGIN/DELETE was issued because the fetch never returned a page.
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(sqls.some((s) => s === "BEGIN")).toBe(false);
    expect(client.released).toBe(true);
  });

  it("propagates an in-flight abort from a caller-supplied signal as-is (P1 round 6)", async () => {
    // Counterpart to the test above: if the operator cancels via
    // `input.signal` while the fetcher is mid-flight (deadline has NOT
    // lapsed), the abort error should propagate as-is rather than be
    // mislabelled as a 300 s server-side timeout. The route handler's
    // fallthrough will still throw it, but the rebuild path itself
    // must not synthesise a fake `RebuildTimeoutError` from a caller
    // cancellation.
    const client = createMockClient(true);
    mockGetCustomerPool.mockResolvedValue({ connect: async () => client });
    const abortError: Error & { code?: string } = Object.assign(
      new Error("aborted by caller"),
      { name: "AbortError", code: "ABORT_ERR" },
    );
    const fetchPage = vi.fn().mockRejectedValue(abortError);
    // Use a fresh controller that has NOT been aborted yet, then abort
    // it after the rebuild starts but the fetcher will reject anyway.
    // We don't need to actually wire abort timing here — the assertion
    // is that without a deadline lapse / timeoutSignal abort, the
    // catch arm leaves the abort error untouched.
    const controller = new AbortController();
    const { runTriageBaselineRebuild, RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    await expect(
      runTriageBaselineRebuild({
        customerId: 72,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        signal: controller.signal,
        testOverrides: { fetchPage },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    // Sanity: the error is NOT a RebuildTimeoutError — otherwise the
    // route handler would mis-map it to the 300 s-cap toast copy.
    try {
      await runTriageBaselineRebuild({
        customerId: 72,
        fromIso: "2026-01-01T00:00:00.000Z",
        toIso: "2026-01-02T00:00:00.000Z",
        signal: controller.signal,
        testOverrides: { fetchPage },
      });
    } catch (err) {
      expect(err).not.toBeInstanceOf(RebuildTimeoutError);
    }
  });
});
