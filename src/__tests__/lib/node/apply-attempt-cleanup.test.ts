import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

beforeEach(() => {
  mockQuery.mockReset();
  mockWithTransaction.mockReset();
});

describe("terminaliseExpiredAttempt", () => {
  it("transitions pending → expired and writes retention deadline", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const { terminaliseExpiredAttempt } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const affected = await terminaliseExpiredAttempt(undefined, {
      attemptId: "att-1",
      status: "pending",
    });
    expect(affected).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = \$2/);
    expect(params?.[1]).toBe("expired");
    expect(params?.[3]).toBe("pending");
    // pending must NOT cascade per-dispatch state (the umbrella spec).
    expect(sql).not.toMatch(/jsonb_array_elements/);
  });

  it("transitions failed_retryable → failed_terminal and cascades per-dispatch", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const { terminaliseExpiredAttempt } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const affected = await terminaliseExpiredAttempt(undefined, {
      attemptId: "att-1",
      status: "failed_retryable",
    });
    expect(affected).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params?.[1]).toBe("failed_terminal");
    expect(params?.[4]).toBe("failed_retryable");
    // Cascade SQL is present.
    expect(sql).toMatch(/jsonb_array_elements/);
    expect(sql).toMatch(/'failed_terminal'/);
  });

  it("returns 0 for non-eligible source states", async () => {
    const { terminaliseExpiredAttempt } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(
      await terminaliseExpiredAttempt(undefined, {
        attemptId: "att-1",
        status: "executing",
      }),
    ).toBe(0);
    expect(
      await terminaliseExpiredAttempt(undefined, {
        attemptId: "att-1",
        status: "succeeded",
      }),
    ).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("WHERE clause guards on executing_lock IS NULL, source status, and SQL NOW() > expires_at", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { terminaliseExpiredAttempt } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    await terminaliseExpiredAttempt(undefined, {
      attemptId: "att-1",
      status: "pending",
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE attempt_id = \$1/);
    expect(sql).toMatch(/AND executing_lock IS NULL/);
    expect(sql).toMatch(/AND status = \$/);
    // The expiry decision is delegated to PostgreSQL's clock, not the
    // host process's `Date.now()`. Without this predicate a host clock
    // ahead of the DB could terminate a row that is still in-window.
    expect(sql).toMatch(/AND NOW\(\) > expires_at/);
  });

  it("failed_retryable cascade SQL also guards on NOW() > expires_at", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { terminaliseExpiredAttempt } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    await terminaliseExpiredAttempt(undefined, {
      attemptId: "att-1",
      status: "failed_retryable",
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/AND NOW\(\) > expires_at/);
  });
});

describe("runApplyAttemptCleanup", () => {
  it("runs every sweep in a single transaction and returns the per-sweep counts", async () => {
    const queries: Array<{ sql: string; rowCount: number }> = [
      { sql: "stale-recovery", rowCount: 1 }, // recoverStaleLocks
      { sql: "pending-expired", rowCount: 2 }, // terminaliseExpired - pending
      { sql: "failed-retryable", rowCount: 3 }, // terminaliseExpired - failed_retryable
      { sql: "purge", rowCount: 4 }, // purgeRetained
    ];
    let i = 0;
    const mockClient = {
      query: vi.fn(async () => ({
        rows: [],
        rowCount: queries[i++]?.rowCount ?? 0,
      })),
    };
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { runApplyAttemptCleanup } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const result = await runApplyAttemptCleanup();
    expect(result).toEqual({ recovered: 1, expired: 5, purged: 4 });
    expect(mockClient.query).toHaveBeenCalledTimes(4);
  });
});

describe("verifyInternalCleanupToken", () => {
  beforeEach(() => {
    delete process.env.APPLY_INTERNAL_CLEANUP_TOKEN;
  });

  it("returns false when the env var is unset", async () => {
    const { verifyInternalCleanupToken } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(verifyInternalCleanupToken("any")).toBe(false);
  });

  it("returns false on null or empty input", async () => {
    process.env.APPLY_INTERNAL_CLEANUP_TOKEN = "secret";
    const { verifyInternalCleanupToken } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(verifyInternalCleanupToken(null)).toBe(false);
    expect(verifyInternalCleanupToken("")).toBe(false);
  });

  it("returns false on length mismatch even if a prefix matches", async () => {
    process.env.APPLY_INTERNAL_CLEANUP_TOKEN = "abcdef";
    const { verifyInternalCleanupToken } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(verifyInternalCleanupToken("abcde")).toBe(false);
    expect(verifyInternalCleanupToken("abcdefg")).toBe(false);
  });

  it("accepts an exact match", async () => {
    process.env.APPLY_INTERNAL_CLEANUP_TOKEN = "the-secret-token";
    const { verifyInternalCleanupToken } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(verifyInternalCleanupToken("the-secret-token")).toBe(true);
  });
});
