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

function createMockPool(
  {
    lockAcquired,
    throwOnLock,
  }: {
    lockAcquired: boolean;
    throwOnLock?: boolean;
  } = {
    lockAcquired: true,
  },
): MockPool {
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
        return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
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

describe("runTriageBaselineCadence — advisory lock + status machine", () => {
  it("commits with status=ok when the advisory lock is acquired", async () => {
    const pool = createMockPool({ lockAcquired: true });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const result = await runTriageBaselineCadence(42);

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
  });

  it("passes the namespaced lock-key string into hashtext", async () => {
    const pool = createMockPool({ lockAcquired: true });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    await runTriageBaselineCadence(42);

    const lockCall = pool.client.queries.find((q) =>
      q.sql.includes("pg_try_advisory_xact_lock"),
    );
    expect(lockCall?.params).toEqual(["triage_baseline_cadence:42"]);
  });

  it("returns status=skipped without UPDATEing state when the lock is unavailable", async () => {
    const pool = createMockPool({ lockAcquired: false });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const result = await runTriageBaselineCadence(42);

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
    const pool = createMockPool({ lockAcquired: true, throwOnLock: true });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    const result = await runTriageBaselineCadence(42);

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
    await expect(runTriageBaselineCadence(99)).rejects.toBeInstanceOf(
      MockCustomerNotFoundError,
    );
  });

  it("re-throws unexpected errors from getCustomerPool", async () => {
    mockGetCustomerPool.mockRejectedValue(new Error("DNS down"));

    const { runTriageBaselineCadence } = await import(
      "@/lib/triage/baseline/cadence"
    );
    await expect(runTriageBaselineCadence(99)).rejects.toThrow("DNS down");
  });
});
