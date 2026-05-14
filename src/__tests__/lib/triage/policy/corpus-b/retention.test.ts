import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockAuthQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  query: mockAuthQuery,
}));

import {
  FAILED_RETENTION_DAYS,
  READY_RETENTION_DAYS,
  runPolicyRetentionDispatch,
  runPolicyRetentionForCustomer,
  SUPERSEDED_RETENTION_DAYS,
  verifyTriagePolicyRetentionToken,
  ZOMBIE_TIMEOUT_MS,
} from "@/lib/triage/policy/corpus-b/retention";

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface PoolBehavior {
  zombieRows?: number;
  readyRows?: number[];
  supersededRows?: number[];
  failedRows?: number[];
  ownerRows?: { owner_account_id: string }[];
  orphanedRows?: number;
}

function makePool(behavior: PoolBehavior = {}) {
  const queries: QueryCall[] = [];
  const readyQueue = [...(behavior.readyRows ?? [0])];
  const supersededQueue = [...(behavior.supersededRows ?? [0])];
  const failedQueue = [...(behavior.failedRows ?? [0])];
  // The ready path now does SELECT id → DELETE id=ANY, with the
  // protection hook short-circuiting the DELETE when every row is
  // protected. To keep the test mocks readable we mirror that shape:
  // each `readyRows[i]` entry produces a SELECT returning `i` synthetic
  // ids, and the matching DELETE returns the same count. Ids are
  // numeric strings to match `policy_triage_run.id` (BIGSERIAL → pg
  // surfaces bigint as string by default), so the `bigint[]` cast in
  // retention.ts is type-correct against the same shape.
  let readyDeletePending = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.startsWith("UPDATE policy_triage_run")) {
        return { rows: [], rowCount: behavior.zombieRows ?? 0 };
      }
      if (sql.includes("SELECT DISTINCT owner_account_id")) {
        return {
          rows: behavior.ownerRows ?? [],
          rowCount: behavior.ownerRows?.length ?? 0,
        };
      }
      if (
        sql.includes("SELECT id FROM policy_triage_run") &&
        sql.includes("'ready'")
      ) {
        const n = readyQueue.shift() ?? 0;
        readyDeletePending = n;
        const rows = Array.from({ length: n }, (_, i) => ({
          id: String(i + 1),
        }));
        return { rows, rowCount: n };
      }
      if (
        sql.includes("DELETE FROM policy_triage_run") &&
        sql.includes("owner_account_id = ANY")
      ) {
        return { rows: [], rowCount: behavior.orphanedRows ?? 0 };
      }
      if (
        sql.includes("DELETE FROM policy_triage_run") &&
        sql.includes("id = ANY")
      ) {
        const n = readyDeletePending;
        readyDeletePending = 0;
        return { rows: [], rowCount: n };
      }
      if (sql.includes("DELETE FROM policy_triage_run")) {
        if (sql.includes("'superseded'")) {
          return { rows: [], rowCount: supersededQueue.shift() ?? 0 };
        }
        if (sql.includes("'failed'")) {
          return { rows: [], rowCount: failedQueue.shift() ?? 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool, queries };
}

describe("runPolicyRetentionForCustomer", () => {
  beforeEach(() => {
    mockGetCustomerPool.mockReset();
    mockAuthQuery.mockReset();
  });

  it("runs the zombie reaper before the failed-retention sweep so timed-out rows are eligible same tick", async () => {
    const { pool, queries } = makePool({
      zombieRows: 2,
      readyRows: [0],
      supersededRows: [0],
      failedRows: [3], // includes the freshly-flipped zombies
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runPolicyRetentionForCustomer(7);

    expect(counts).toEqual({
      zombiesReaped: 2,
      readyPruned: 0,
      supersededPruned: 0,
      failedPruned: 3,
      orphanedPruned: 0,
    });

    // Order: UPDATE (zombie reaper) → DELETE ready → DELETE superseded
    // → DELETE failed → SELECT owners (no orphans, so no DELETE).
    const sqls = queries.map((q) => q.sql);
    const zombieIdx = sqls.findIndex(
      (s) =>
        s.startsWith("UPDATE policy_triage_run") &&
        s.includes("'timeout: runner did not finalize'"),
    );
    const failedIdx = sqls.findIndex(
      (s) =>
        s.includes("DELETE FROM policy_triage_run") && s.includes("'failed'"),
    );
    expect(zombieIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(zombieIdx);
  });

  it("uses the documented retention windows for each status predicate", async () => {
    const { pool, queries } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    await runPolicyRetentionForCustomer(1);

    // The `ready` path now SELECTs candidate ids before issuing a
    // generic DELETE keyed by `id = ANY(...)`, so the retention-days
    // param lives on the SELECT instead of the DELETE.
    const readyCall = queries.find(
      (q) => q.sql.includes("SELECT id FROM") && q.sql.includes("'ready'"),
    );
    const supersededCall = queries.find(
      (q) => q.sql.includes("DELETE FROM") && q.sql.includes("'superseded'"),
    );
    const failedCall = queries.find(
      (q) => q.sql.includes("DELETE FROM") && q.sql.includes("'failed'"),
    );
    expect(readyCall?.params).toEqual([String(READY_RETENTION_DAYS)]);
    expect(supersededCall?.params).toEqual([String(SUPERSEDED_RETENTION_DAYS)]);
    expect(failedCall?.params).toEqual([String(FAILED_RETENTION_DAYS)]);
  });

  it("uses the documented 30-minute zombie threshold", async () => {
    const { pool, queries } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    await runPolicyRetentionForCustomer(1);

    const zombieCall = queries.find((q) =>
      q.sql.startsWith("UPDATE policy_triage_run"),
    );
    expect(zombieCall?.params).toEqual([String(ZOMBIE_TIMEOUT_MS)]);
    expect(zombieCall?.sql).toContain("status = 'failed'");
    expect(zombieCall?.sql).toContain(
      "last_error = 'timeout: runner did not finalize'",
    );
    // The reaper drives off created_at because computing rows have NULL
    // finalized_at; using finalized_at would skip every timed-out runner.
    expect(zombieCall?.sql).toContain("created_at <");
  });

  it("collapses owner-orphan cleanup to one DELETE against the unresolved set", async () => {
    const { pool, queries } = makePool({
      ownerRows: [
        { owner_account_id: "owner-A" },
        { owner_account_id: "owner-B" },
      ],
      orphanedRows: 7,
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    // Only owner-A resolves in auth_db; owner-B is orphaned.
    mockAuthQuery.mockResolvedValueOnce({
      rows: [{ id: "owner-A" }],
      rowCount: 1,
    });

    const counts = await runPolicyRetentionForCustomer(1);

    expect(counts.orphanedPruned).toBe(7);
    // The cross-DB probe to auth_db.accounts was issued exactly once
    // with the full owner set.
    expect(mockAuthQuery).toHaveBeenCalledTimes(1);
    expect(mockAuthQuery.mock.calls[0][1]).toEqual([["owner-A", "owner-B"]]);
    // Subsequent DELETE was scoped to the unresolved owners only.
    const orphanDelete = queries.find(
      (q) =>
        q.sql.includes("DELETE FROM policy_triage_run") &&
        q.sql.includes("owner_account_id = ANY"),
    );
    expect(orphanDelete?.params).toEqual([["owner-B"]]);
  });

  it("respects the Phase 2 protection hook on the ready path so protected runs are not pruned", async () => {
    // Three candidate ready rows: id "1" is protected (e.g. has a
    // SendBatch in flight), "2" and "3" are eligible. The helper
    // SELECTs candidates, calls the hook per row, then issues one
    // DELETE keyed by the surviving ids. Ids are numeric strings to
    // match `policy_triage_run.id` (BIGSERIAL).
    const protectedId = "1";
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT id FROM") && sql.includes("'ready'")) {
          // First call returns three candidates; second call (after
          // protectedIds excludes "1") returns nothing → loop exits.
          if ((params as unknown[]).length === 1) {
            return {
              rows: [{ id: "1" }, { id: "2" }, { id: "3" }],
              rowCount: 3,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("DELETE FROM policy_triage_run") &&
          sql.includes("id = ANY")
        ) {
          // The DELETE must skip the protected id and be cast to bigint[].
          expect(sql).toContain("$1::bigint[]");
          const ids = (params as [string[]])[0];
          return { rows: [], rowCount: ids.length };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const previousHook = (
      await import("@/lib/triage/policy/corpus-b/retention")
    )._protectionExtensionHook.current;
    const hookCalls: string[] = [];
    (
      await import("@/lib/triage/policy/corpus-b/retention")
    )._protectionExtensionHook.current = async (id: string) => {
      hookCalls.push(id);
      return id === protectedId;
    };
    try {
      const counts = await runPolicyRetentionForCustomer(1);
      expect(hookCalls).toEqual(["1", "2", "3"]);
      // Only the two unprotected rows were deleted.
      expect(counts.readyPruned).toBe(2);
      // The DELETE call carried the unprotected ids only.
      const deleteCall = pool.query.mock.calls.find((c) => {
        const sql = c[0] as string;
        return sql.includes("DELETE FROM") && sql.includes("id = ANY");
      });
      expect(deleteCall?.[1]).toEqual([["2", "3"]]);
    } finally {
      (
        await import("@/lib/triage/policy/corpus-b/retention")
      )._protectionExtensionHook.current = previousHook;
    }
  });

  it("excludes already-protected ids from subsequent SELECTs so a full-batch of protected rows cannot loop forever", async () => {
    // First batch returns batchSize (= 2) rows, one protected. The
    // helper deletes the unprotected row, then issues another SELECT
    // because the first batch was full — that SELECT must exclude the
    // protected id via `id <> ALL($2::bigint[])` so the loop terminates.
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT id FROM") && sql.includes("'ready'")) {
          const args = (params ?? []) as unknown[];
          if (args.length === 1) {
            // First call: full batch.
            return {
              rows: [{ id: "10" }, { id: "11" }],
              rowCount: 2,
            };
          }
          // Second call: protectedIds excluded; nothing else matches.
          // The id-exclusion cast must be bigint[] to match the
          // BIGSERIAL primary key of policy_triage_run.
          expect(sql).toContain("$2::bigint[]");
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("DELETE FROM policy_triage_run") &&
          sql.includes("id = ANY")
        ) {
          expect(sql).toContain("$1::bigint[]");
          const ids = (params as [string[]])[0];
          return { rows: [], rowCount: ids.length };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const previousHook = (
      await import("@/lib/triage/policy/corpus-b/retention")
    )._protectionExtensionHook.current;
    (
      await import("@/lib/triage/policy/corpus-b/retention")
    )._protectionExtensionHook.current = async (id: string) => id === "10";
    try {
      const counts = await runPolicyRetentionForCustomer(1, { batchSize: 2 });
      expect(counts.readyPruned).toBe(1);
      // The second SELECT carried the protected id in its NOT-IN list,
      // typed as bigint[] to match policy_triage_run.id.
      const followup = pool.query.mock.calls.find((c) => {
        const sql = c[0] as string;
        return (
          sql.includes("SELECT id FROM") &&
          sql.includes("'ready'") &&
          sql.includes("id <> ALL")
        );
      });
      expect(followup?.[1]).toEqual([String(READY_RETENTION_DAYS), ["10"]]);
      const followupSql = followup?.[0] as string;
      expect(followupSql).toContain("$2::bigint[]");
    } finally {
      (
        await import("@/lib/triage/policy/corpus-b/retention")
      )._protectionExtensionHook.current = previousHook;
    }
  });

  it("skips the auth-db probe when no rows reference an owner", async () => {
    const { pool, queries } = makePool({ ownerRows: [] });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runPolicyRetentionForCustomer(1);

    expect(counts.orphanedPruned).toBe(0);
    expect(mockAuthQuery).not.toHaveBeenCalled();
    // No orphan DELETE issued either.
    expect(
      queries.some(
        (q) =>
          q.sql.includes("DELETE FROM policy_triage_run") &&
          q.sql.includes("owner_account_id = ANY"),
      ),
    ).toBe(false);
  });
});

describe("runPolicyRetentionDispatch", () => {
  it("captures per-customer failures and reports overall='partial'", async () => {
    const result = await runPolicyRetentionDispatch({
      listActiveCustomers: async () => [1, 2],
      runForCustomer: async (id) => {
        if (id === 2) throw new Error("boom");
        return {
          zombiesReaped: 1,
          readyPruned: 2,
          supersededPruned: 3,
          failedPruned: 4,
          orphanedPruned: 0,
        };
      },
    });

    expect(result.overall).toBe("partial");
    expect(result.perCustomer[0]).toMatchObject({
      customerId: 1,
      status: "ok",
    });
    expect(result.perCustomer[1]).toMatchObject({
      customerId: 2,
      status: "failed",
      error: "boom",
      counts: {
        zombiesReaped: 0,
        readyPruned: 0,
        supersededPruned: 0,
        failedPruned: 0,
        orphanedPruned: 0,
      },
    });
  });

  it("returns overall='ok' when every per-customer sweep succeeds", async () => {
    const result = await runPolicyRetentionDispatch({
      listActiveCustomers: async () => [1],
      runForCustomer: async () => ({
        zombiesReaped: 0,
        readyPruned: 0,
        supersededPruned: 0,
        failedPruned: 0,
        orphanedPruned: 0,
      }),
    });
    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toHaveLength(1);
  });
});

describe("verifyTriagePolicyRetentionToken", () => {
  const ENV_KEY = "TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("rejects when env unset", () => {
    delete process.env[ENV_KEY];
    expect(verifyTriagePolicyRetentionToken("anything")).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret";
    expect(verifyTriagePolicyRetentionToken("secret")).toBe(true);
  });

  it("rejects same-length mismatch (constant-time)", () => {
    process.env[ENV_KEY] = "secretX";
    expect(verifyTriagePolicyRetentionToken("secretY")).toBe(false);
  });
});
