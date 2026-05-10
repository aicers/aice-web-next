import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

class MockCustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

interface QueuedRow {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface MockClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  released: boolean;
  query: ReturnType<typeof vi.fn>;
  release: () => void;
}

interface MockPool {
  client: MockClient;
  poolQueries: Array<{ sql: string; params: unknown[] | undefined }>;
  query: ReturnType<typeof vi.fn>;
  connect: () => Promise<MockClient>;
}

function createMockPool({
  lockSequence,
  throwOnLock,
}: {
  /**
   * Per-page lock-acquired booleans. The mock pops one each time the
   * runner runs `pg_try_advisory_xact_lock`. If the array is exhausted
   * the last value is reused (so a single-element array means "always
   * acquired" / "always denied").
   */
  lockSequence?: boolean[];
  throwOnLock?: boolean;
} = {}): MockPool {
  const sequence = lockSequence ?? [true];
  let lockCallIndex = 0;

  const client: MockClient = {
    queries: [],
    released: false,
    query: vi.fn(),
    release() {
      client.released = true;
    },
  };

  client.query.mockImplementation(
    async (sql: string, params?: unknown[]): Promise<QueuedRow> => {
      client.queries.push({ sql, params });
      if (sql.includes("pg_try_advisory_xact_lock")) {
        if (throwOnLock) throw new Error("lock probe blew up");
        const acquired =
          sequence[Math.min(lockCallIndex, sequence.length - 1)] ?? false;
        lockCallIndex += 1;
        return { rows: [{ acquired }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT last_ingested_at")) {
        return {
          rows: [
            {
              last_ingested_at: null,
              last_event_cursor: null,
              baseline_version: null,
              exclusions_fp: null,
              last_run_status: null,
              last_error: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  );

  const poolQueries: MockPool["poolQueries"] = [];
  const pool: MockPool = {
    client,
    poolQueries,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    connect: async () => client,
  };
  return pool;
}

const ORIGINAL_TOKEN = process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN;

beforeEach(() => {
  mockGetCustomerPool.mockReset();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN;
  } else {
    process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN = ORIGINAL_TOKEN;
  }
});

describe("verifyTriageBaselineCadenceToken", () => {
  it("returns false when env var is unset", async () => {
    delete process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN;
    const { verifyTriageBaselineCadenceToken } = await import(
      "@/lib/triage/baseline/cadence"
    );
    expect(verifyTriageBaselineCadenceToken("anything")).toBe(false);
  });

  it("returns false when the supplied token is null", async () => {
    process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN = "secret-token";
    const { verifyTriageBaselineCadenceToken } = await import(
      "@/lib/triage/baseline/cadence"
    );
    expect(verifyTriageBaselineCadenceToken(null)).toBe(false);
  });

  it("returns false when lengths differ (timing-safe precheck)", async () => {
    process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN = "secret";
    const { verifyTriageBaselineCadenceToken } = await import(
      "@/lib/triage/baseline/cadence"
    );
    expect(verifyTriageBaselineCadenceToken("s")).toBe(false);
    expect(verifyTriageBaselineCadenceToken("secret-too-long")).toBe(false);
  });

  it("returns true on an exact match", async () => {
    process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN = "exact-match-token";
    const { verifyTriageBaselineCadenceToken } = await import(
      "@/lib/triage/baseline/cadence"
    );
    expect(verifyTriageBaselineCadenceToken("exact-match-token")).toBe(true);
  });

  it("returns false on equal-length but different content", async () => {
    process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN = "abcdef";
    const { verifyTriageBaselineCadenceToken } = await import(
      "@/lib/triage/baseline/cadence"
    );
    expect(verifyTriageBaselineCadenceToken("abcdeg")).toBe(false);
  });
});

/**
 * Test-only fake pager. By default reports a single empty page so the
 * runner walks one page-transaction and reports `ok`.
 */
type PagerScript = Array<{
  observedInserted?: number;
  baselineInserted?: number;
  endCursor?: string | null;
  hasNextPage?: boolean;
  exclusionsFp?: string;
  throw?: Error;
}>;

interface FakePager {
  ingestPage: (
    client: unknown,
    customerId: number,
    afterCursor: string | null,
  ) => Promise<{
    observedInserted: number;
    baselineInserted: number;
    endCursor: string | null;
    hasNextPage: boolean;
    exclusionsFp: string;
  }>;
  calls: unknown[][];
  callCount: () => number;
}

const TEST_EXCLUSIONS_FP = "test-empty-exclusions-fingerprint";

function makePager(script: PagerScript = [{ hasNextPage: false }]): FakePager {
  const calls: unknown[][] = [];
  let i = 0;
  const ingestPage = async (
    _client: unknown,
    _customerId: number,
    afterCursor: string | null,
  ) => {
    calls.push([afterCursor]);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.throw) throw step.throw;
    return {
      observedInserted: step.observedInserted ?? 0,
      baselineInserted: step.baselineInserted ?? 0,
      endCursor: step.endCursor ?? null,
      hasNextPage: step.hasNextPage ?? false,
      exclusionsFp: step.exclusionsFp ?? TEST_EXCLUSIONS_FP,
    };
  };
  return { ingestPage, calls, callCount: () => calls.length };
}

describe("runTriageBaselineCadence — advisory lock + status machine", () => {
  it("commits with status=ok when the advisory lock is acquired and the pager reports an empty page", async () => {
    const pool = createMockPool({ lockSequence: [true] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const pager = makePager();
    const result = await runTriageBaselineCadence(42, { pager });

    expect(result.status).toBe("ok");
    expect(result.customerId).toBe(42);
    expect(result.observedInserted).toBe(0);
    expect(result.baselineInserted).toBe(0);

    const sqls = pool.client.queries.map((q) => q.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => s.includes("pg_try_advisory_xact_lock"))).toBe(
      true,
    );
    expect(
      sqls.some((s) => s.includes("INSERT INTO baseline_corpus_state")),
    ).toBe(true);
    expect(sqls.some((s) => s.includes("last_run_status = 'running'"))).toBe(
      true,
    );
    expect(sqls.some((s) => s.includes("last_run_status = 'ok'"))).toBe(true);
    expect(sqls).toContain("COMMIT");
    expect(pool.client.released).toBe(true);
    expect(pager.callCount()).toBe(1);
  });

  it("passes the namespaced lock-key string into hashtext", async () => {
    const pool = createMockPool({ lockSequence: [true] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    await runTriageBaselineCadence(42, { pager: makePager() });

    const lockCall = pool.client.queries.find((q) =>
      q.sql.includes("pg_try_advisory_xact_lock"),
    );
    expect(lockCall?.params).toEqual(["triage_baseline_cadence:42"]);
  });

  it("returns status=skipped without UPDATEing state when the lock is unavailable on the first page", async () => {
    const pool = createMockPool({ lockSequence: [false] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const result = await runTriageBaselineCadence(42, { pager: makePager() });

    expect(result.status).toBe("skipped");
    const sqls = pool.client.queries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
    expect(sqls.some((s) => s.includes("last_run_status = 'ok'"))).toBe(false);
    expect(sqls.some((s) => s.includes("last_run_status = 'running'"))).toBe(
      false,
    );
    expect(pool.client.released).toBe(true);
  });

  it("returns status=failed and persists the error on rollback", async () => {
    const pool = createMockPool({ lockSequence: [true], throwOnLock: true });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const result = await runTriageBaselineCadence(42, { pager: makePager() });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("lock probe blew up");

    const sqls = pool.client.queries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
    expect(pool.client.released).toBe(true);

    // Failure is recorded outside the transaction (pool.query, not client.query)
    const failureWrite = pool.poolQueries.find((q) =>
      q.sql.includes("INSERT INTO baseline_corpus_state"),
    );
    expect(failureWrite).toBeDefined();
    expect(failureWrite?.params?.[0]).toBe("lock probe blew up");
  });

  it("propagates CustomerNotFoundError so the route handler can return 404", async () => {
    mockGetCustomerPool.mockRejectedValue(new MockCustomerNotFoundError(99));

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    await expect(
      runTriageBaselineCadence(99, { pager: makePager() }),
    ).rejects.toBeInstanceOf(MockCustomerNotFoundError);
  });

  it("re-throws unexpected errors from getCustomerPool", async () => {
    mockGetCustomerPool.mockRejectedValue(new Error("DNS down"));

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    await expect(
      runTriageBaselineCadence(99, { pager: makePager() }),
    ).rejects.toThrow("DNS down");
  });
});

describe("runTriageBaselineCadence — per-page transaction discipline", () => {
  it("commits each page in its own transaction and reacquires the advisory lock per page", async () => {
    const pool = createMockPool({ lockSequence: [true, true] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const pager = makePager([
      {
        observedInserted: 3,
        baselineInserted: 1,
        endCursor: "c1",
        hasNextPage: true,
      },
      {
        observedInserted: 2,
        baselineInserted: 0,
        endCursor: "c2",
        hasNextPage: false,
      },
    ]);
    const result = await runTriageBaselineCadence(7, { pager });

    expect(result.status).toBe("ok");
    expect(result.observedInserted).toBe(5);
    expect(result.baselineInserted).toBe(1);
    expect(result.lastEventCursor).toBe("c2");

    const sqls = pool.client.queries.map((q) => q.sql);
    const begins = sqls.filter((s) => s === "BEGIN").length;
    const commits = sqls.filter((s) => s === "COMMIT").length;
    const lockProbes = sqls.filter((s) =>
      s.includes("pg_try_advisory_xact_lock"),
    ).length;
    expect(begins).toBe(2);
    expect(commits).toBe(2);
    expect(lockProbes).toBe(2);

    // Page 1 is invoked with the cursor page 0 returned.
    expect(pager.calls).toEqual([[null], ["c1"]]);
  });

  it("preserves earlier pages' commits and persists the failure when a later page throws", async () => {
    const pool = createMockPool({ lockSequence: [true, true] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const pager = makePager([
      {
        observedInserted: 4,
        baselineInserted: 2,
        endCursor: "c1",
        hasNextPage: true,
      },
      { throw: new Error("review timeout") },
    ]);
    const result = await runTriageBaselineCadence(7, { pager });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("review timeout");
    expect(result.observedInserted).toBe(4);
    expect(result.baselineInserted).toBe(2);
    expect(result.lastEventCursor).toBe("c1");

    const sqls = pool.client.queries.map((q) => q.sql);
    expect(sqls.filter((s) => s === "COMMIT").length).toBe(1);
    expect(sqls.filter((s) => s === "ROLLBACK").length).toBe(1);

    const failureWrite = pool.poolQueries.find((q) =>
      q.sql.includes("INSERT INTO baseline_corpus_state"),
    );
    expect(failureWrite?.params?.[0]).toBe("review timeout");
  });

  it("writes the per-page exclusionsFp from the pager to baseline_corpus_state, not a runner-side constant", async () => {
    const pool = createMockPool({ lockSequence: [true] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const pager = makePager([
      {
        observedInserted: 0,
        baselineInserted: 0,
        endCursor: "c1",
        hasNextPage: false,
        // The pager is the single source of truth for the active-set
        // fingerprint of a given page. The runner must propagate this
        // value as-is, so when #457 swaps in real (non-empty) storage,
        // the corpus-state row stays in lockstep with the per-row
        // `exclusions_fp` written into `baseline_triaged_event`.
        exclusionsFp: "non-empty-fp-from-pager",
      },
    ]);
    const result = await runTriageBaselineCadence(7, { pager });

    expect(result.status).toBe("ok");
    const okWrite = pool.client.queries.find((q) =>
      q.sql.includes("last_run_status = 'ok'"),
    );
    expect(okWrite?.params?.[2]).toBe("non-empty-fp-from-pager");
  });

  it("stops cleanly mid-run if the advisory lock is lost between page commits", async () => {
    const pool = createMockPool({ lockSequence: [true, false] });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const pager = makePager([
      {
        observedInserted: 1,
        baselineInserted: 1,
        endCursor: "c1",
        hasNextPage: true,
      },
      {
        observedInserted: 99,
        baselineInserted: 99,
        endCursor: "c2",
        hasNextPage: false,
      },
    ]);
    const result = await runTriageBaselineCadence(7, { pager });

    expect(result.status).toBe("ok");
    // Only the first page actually committed; the second never got the
    // lock so the pager was not called for it.
    expect(result.observedInserted).toBe(1);
    expect(result.baselineInserted).toBe(1);
    expect(result.lastEventCursor).toBe("c1");
    expect(pager.callCount()).toBe(1);
  });
});
