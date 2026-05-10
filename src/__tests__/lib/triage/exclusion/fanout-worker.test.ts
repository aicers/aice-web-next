import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockAuditLogRecord = vi.hoisted(() =>
  vi.fn(async (_payload: Record<string, unknown>) => undefined),
);
const mockWithTransaction = vi.hoisted(() =>
  vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    // Default: route every withTransaction onto the auth-DB mock client
    // installed by the per-test setup. The setup may swap this out.
    return fn((globalThis as Record<string, unknown>).__authClient__);
  }),
);

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  withTransaction: mockWithTransaction,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditLogRecord },
}));

import {
  backoffMs,
  MAX_ATTEMPTS,
  runFanoutSweep,
  STUCK_JOB_THRESHOLD_MS,
  verifyFanoutToken,
} from "@/lib/triage/exclusion/fanout-worker";

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface PendingJobRow {
  id: string;
  global_exclusion_id: string;
  customer_id: number;
  attempt_count: number;
}

interface GlobalExclusionRow {
  id: string;
  kind: "ipAddress" | "hostname" | "uri" | "domain";
  value: string;
  domain_suffix: string | null;
}

/**
 * In-memory mock of the auth-DB client. Tracks query calls and
 * records UPDATEs to a synthetic `triage_exclusion_fanout_job` map so
 * the assertions can read final job state without a real Postgres.
 */
function makeAuthClient(opts: {
  pendingJobs: PendingJobRow[];
  global: GlobalExclusionRow | null;
  recoverableStuckCount?: number;
}) {
  const queries: QueryCall[] = [];
  const jobsById = new Map<
    string,
    {
      id: string;
      status: "pending" | "running" | "completed" | "failed";
      attempt_count: number;
      claimed_at: string | null;
      last_error: string | null;
      next_attempt_at_ms: number;
    }
  >();
  for (const j of opts.pendingJobs) {
    jobsById.set(j.id, {
      id: j.id,
      status: "pending",
      attempt_count: j.attempt_count,
      claimed_at: null,
      last_error: null,
      next_attempt_at_ms: 0,
    });
  }
  let recovered = opts.recoverableStuckCount ?? 0;
  let claimedThisInvocation = false;

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    // Stuck-job sweep
    if (
      sql.includes("UPDATE triage_exclusion_fanout_job") &&
      sql.includes("status = 'pending'") &&
      sql.includes("status = 'running'") &&
      sql.includes("milliseconds")
    ) {
      const r = recovered;
      recovered = 0;
      return { rows: [], rowCount: r };
    }
    // SELECT pending jobs FOR UPDATE SKIP LOCKED
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      if (claimedThisInvocation) return { rows: [], rowCount: 0 };
      claimedThisInvocation = true;
      const candidates = opts.pendingJobs.filter(
        (j) => jobsById.get(j.id)?.status === "pending",
      );
      return { rows: candidates, rowCount: candidates.length };
    }
    // UPDATE … status = 'running' (claim mark)
    if (
      sql.includes("UPDATE triage_exclusion_fanout_job") &&
      sql.includes("status = 'running'")
    ) {
      const ids = (params?.[0] ?? []) as string[];
      for (const id of ids) {
        const job = jobsById.get(id);
        if (job) job.status = "running";
      }
      return { rows: [], rowCount: ids.length };
    }
    // SELECT global exclusion
    if (sql.includes("FROM global_triage_exclusion")) {
      if (opts.global) {
        return { rows: [opts.global], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    // finalizeCompleted / finalizeRetry / finalizeFailed
    if (sql.includes("UPDATE triage_exclusion_fanout_job")) {
      const id = params?.[params.length - 1] as string;
      const job = jobsById.get(id);
      if (!job) return { rows: [], rowCount: 0 };
      if (sql.includes("status = 'completed'")) {
        job.status = "completed";
        job.claimed_at = null;
        job.last_error = null;
      } else if (sql.includes("status = 'failed'")) {
        job.status = "failed";
        job.attempt_count += 1;
        job.claimed_at = null;
        job.last_error = (params?.[0] as string) ?? null;
      } else if (sql.includes("status = 'pending'")) {
        job.status = "pending";
        job.attempt_count += 1;
        job.claimed_at = null;
        job.last_error = (params?.[1] as string) ?? null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { queries, query, jobsById };
}

interface TenantBehavior {
  /** Simulate a thrown error inside `executeRetroactiveDelete`. */
  throwOnDelete?: Error;
  /** Whether `policy_triaged_event` exists. Defaults to false. */
  policyTableExists?: boolean;
}

function makeTenantPool(behavior: TenantBehavior = {}) {
  const tenantQueries: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      tenantQueries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("to_regclass")) {
        return {
          rows: [{ exists: behavior.policyTableExists ?? false }],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM")) {
        if (behavior.throwOnDelete) throw behavior.throwOnDelete;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
  return { pool, client, tenantQueries };
}

beforeEach(() => {
  mockGetCustomerPool.mockReset();
  mockAuditLogRecord.mockReset();
  mockWithTransaction.mockReset();
});

describe("fanout-worker constants", () => {
  it("uses a 10 minute stuck-job threshold", () => {
    expect(STUCK_JOB_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });

  it("retries up to 5 attempts before failing terminally", () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("returns the documented exponential backoff", () => {
    expect(backoffMs(1)).toBe(1 * 60 * 1000);
    expect(backoffMs(2)).toBe(5 * 60 * 1000);
    expect(backoffMs(3)).toBe(25 * 60 * 1000);
    expect(backoffMs(4)).toBe(2 * 60 * 60 * 1000);
    expect(backoffMs(5)).toBe(12 * 60 * 60 * 1000);
    expect(backoffMs(6)).toBe(12 * 60 * 60 * 1000);
  });
});

describe("verifyFanoutToken", () => {
  const ENV_KEY = "TRIAGE_EXCLUSION_FANOUT_TOKEN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it("rejects when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(verifyFanoutToken("anything")).toBe(false);
  });

  it("rejects null even with env var set", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyFanoutToken(null)).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyFanoutToken("secret-token")).toBe(true);
  });

  it("rejects a length-mismatched token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyFanoutToken("secret")).toBe(false);
  });

  it("rejects a same-length but different token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyFanoutToken("secret-tokeX")).toBe(false);
  });
});

describe("runFanoutSweep — happy path", () => {
  it("claims one pending job, runs DELETE, finalizes completed, emits customer_add audit row", async () => {
    const auth = makeAuthClient({
      pendingJobs: [
        {
          id: "job-1",
          global_exclusion_id: "glob-1",
          customer_id: 7,
          attempt_count: 0,
        },
      ],
      global: {
        id: "glob-1",
        kind: "hostname",
        value: "example.com",
        domain_suffix: null,
      },
    });
    const tenant = makeTenantPool();
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result).toMatchObject({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    expect(auth.jobsById.get("job-1")?.status).toBe("completed");

    // Tenant transaction was used: BEGIN → advisory lock → to_regclass
    // probe → batched DELETEs → COMMIT.
    const tenantSqls = tenant.tenantQueries.map((q) => q.sql);
    expect(tenantSqls).toContain("BEGIN");
    expect(tenantSqls).toContain("COMMIT");
    expect(tenantSqls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(
      true,
    );

    // Audit row emitted with origin = 'global_fanout'.
    expect(mockAuditLogRecord).toHaveBeenCalledTimes(1);
    const auditCall = mockAuditLogRecord.mock.calls[0][0];
    expect(auditCall).toMatchObject({
      action: "triage_exclusion.customer_add",
      target: "triage_exclusion",
      customerId: 7,
      details: expect.objectContaining({
        origin: "global_fanout",
        globalExclusionId: "glob-1",
      }),
    });
  });
});

describe("runFanoutSweep — transient failure then recover", () => {
  it("transitions a failing job back to pending and increments attempt_count, no terminal audit", async () => {
    const auth = makeAuthClient({
      pendingJobs: [
        {
          id: "job-1",
          global_exclusion_id: "glob-1",
          customer_id: 7,
          attempt_count: 1,
        },
      ],
      global: {
        id: "glob-1",
        kind: "hostname",
        value: "example.com",
        domain_suffix: null,
      },
    });
    const tenant = makeTenantPool({
      throwOnDelete: new Error("transient pg error"),
    });
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result.retried).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);

    const finalJob = auth.jobsById.get("job-1");
    expect(finalJob?.status).toBe("pending");
    expect(finalJob?.attempt_count).toBe(2);
    expect(finalJob?.last_error).toContain("transient pg error");

    // No terminal-failure audit row before MAX_ATTEMPTS.
    expect(mockAuditLogRecord).not.toHaveBeenCalled();

    // Tenant ROLLBACK was issued.
    const tenantSqls = tenant.tenantQueries.map((q) => q.sql);
    expect(tenantSqls).toContain("ROLLBACK");
  });
});

describe("runFanoutSweep — terminal failure", () => {
  it("transitions to 'failed' after MAX_ATTEMPTS and emits triage_exclusion.fanout_failed", async () => {
    // attempt_count 4 + this attempt = 5 → exceeds MAX_ATTEMPTS - 1
    // boundary, so the next failure is terminal.
    const auth = makeAuthClient({
      pendingJobs: [
        {
          id: "job-doom",
          global_exclusion_id: "glob-doom",
          customer_id: 99,
          attempt_count: MAX_ATTEMPTS - 1,
        },
      ],
      global: {
        id: "glob-doom",
        kind: "hostname",
        value: "doomed.example",
        domain_suffix: null,
      },
    });
    const tenant = makeTenantPool({
      throwOnDelete: new Error("permanent pg error"),
    });
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    const finalJob = auth.jobsById.get("job-doom");
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.attempt_count).toBe(MAX_ATTEMPTS);

    expect(mockAuditLogRecord).toHaveBeenCalledTimes(1);
    const auditCall = mockAuditLogRecord.mock.calls[0][0];
    expect(auditCall).toMatchObject({
      action: "triage_exclusion.fanout_failed",
      customerId: 99,
      details: expect.objectContaining({
        globalExclusionId: "glob-doom",
        attemptCount: MAX_ATTEMPTS,
        lastError: expect.stringContaining("permanent pg error"),
      }),
    });
  });
});

describe("runFanoutSweep — stuck-job sweep", () => {
  it("returns recovered count and does not increment attempt_count for stuck rows", async () => {
    const auth = makeAuthClient({
      pendingJobs: [],
      global: null,
      recoverableStuckCount: 3,
    });
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result.recovered).toBe(3);
    expect(result.claimed).toBe(0);

    // Verify the sweep SQL was issued and that it does NOT touch
    // attempt_count.
    const sweepCall = auth.queries.find(
      (q) =>
        q.sql.includes("UPDATE triage_exclusion_fanout_job") &&
        q.sql.includes("milliseconds") &&
        q.sql.includes("status = 'running'"),
    );
    expect(sweepCall).toBeDefined();
    expect(sweepCall?.sql).not.toContain("attempt_count");
  });
});

describe("runFanoutSweep — stuck-job recovery actually completes", () => {
  // Spec acceptance criterion (#457): "A test simulates a crashed
  // worker (commit the claim, do not finalize) and asserts the next
  // invocation re-runs the row to completion."
  it("returns a stuck row to pending and processes it to completion in the same invocation", async () => {
    interface MockJob {
      id: string;
      global_exclusion_id: string;
      customer_id: number;
      attempt_count: number;
      status: "pending" | "running" | "completed" | "failed";
    }
    const job: MockJob = {
      id: "job-stuck",
      global_exclusion_id: "glob-1",
      customer_id: 11,
      attempt_count: 0,
      // Simulates a crashed worker: previous invocation committed the
      // claim (status -> 'running') then died before the DELETE phase.
      status: "running",
    };
    const queries: { sql: string; params?: unknown[] }[] = [];
    let stuckRecoveryDone = false;
    let claimedThisInvocation = false;

    const auth = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        // Stuck-job sweep: drop the running row back to pending. The
        // mock conditions on `stuckRecoveryDone` so the second call
        // returns 0 (the row is now pending and no longer stuck).
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("status = 'pending'") &&
          sql.includes("status = 'running'") &&
          sql.includes("milliseconds")
        ) {
          if (!stuckRecoveryDone && job.status === "running") {
            job.status = "pending";
            stuckRecoveryDone = true;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        // SELECT pending FOR UPDATE SKIP LOCKED — pick up the now-
        // pending row.
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          if (claimedThisInvocation || job.status !== "pending") {
            return { rows: [], rowCount: 0 };
          }
          claimedThisInvocation = true;
          return {
            rows: [
              {
                id: job.id,
                global_exclusion_id: job.global_exclusion_id,
                customer_id: job.customer_id,
                attempt_count: job.attempt_count,
              },
            ],
            rowCount: 1,
          };
        }
        // Claim mark UPDATE.
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("status = 'running'")
        ) {
          job.status = "running";
          return { rows: [], rowCount: 1 };
        }
        // Global lookup.
        if (sql.includes("FROM global_triage_exclusion")) {
          return {
            rows: [
              {
                id: "glob-1",
                kind: "hostname",
                value: "stuck.example",
                domain_suffix: null,
              },
            ],
            rowCount: 1,
          };
        }
        // finalizeCompleted.
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("status = 'completed'")
        ) {
          job.status = "completed";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const tenant = makeTenantPool();
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    // The single invocation recovered the stuck row AND ran it to
    // completion — proving the sweep doesn't stop at recovery.
    expect(result).toMatchObject({
      recovered: 1,
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    expect(job.status).toBe("completed");
    // attempt_count stayed at 0 — the stuck recovery is a process
    // death, not a logical failure (spec: "does NOT increment
    // attempt_count"). The mock does not increment on any call this
    // test exercised.
    expect(job.attempt_count).toBe(0);
    // Audit row emitted as a real customer_add.
    expect(mockAuditLogRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditLogRecord.mock.calls[0][0]).toMatchObject({
      action: "triage_exclusion.customer_add",
      customerId: 11,
    });
  });
});

describe("runFanoutSweep — terminal failure audit details", () => {
  it("includes id/kind/value on the fanout_failed audit row per spec", async () => {
    // Spec acceptance criterion (#457): "All five actions:
    // details.kind, details.value, details.id (the exclusion row id)."
    const auth = makeAuthClient({
      pendingJobs: [
        {
          id: "job-doom-2",
          global_exclusion_id: "glob-doom-2",
          customer_id: 33,
          attempt_count: MAX_ATTEMPTS - 1,
        },
      ],
      global: {
        id: "glob-doom-2",
        kind: "ipAddress",
        value: "10.0.0.0/24",
        domain_suffix: null,
      },
    });
    const tenant = makeTenantPool({
      throwOnDelete: new Error("permanent pg error"),
    });
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    await runFanoutSweep({ batchSize: 5 });

    const failedCall = mockAuditLogRecord.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "triage_exclusion.fanout_failed",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall?.[0]).toMatchObject({
      action: "triage_exclusion.fanout_failed",
      details: expect.objectContaining({
        id: "glob-doom-2",
        kind: "ipAddress",
        value: "10.0.0.0/24",
        globalExclusionId: "glob-doom-2",
        attemptCount: MAX_ATTEMPTS,
      }),
    });
  });
});

describe("runFanoutSweep — global exclusion already deleted", () => {
  it("treats a missing global row as a completed no-op (cascade already handled siblings)", async () => {
    const auth = makeAuthClient({
      pendingJobs: [
        {
          id: "job-orphan",
          global_exclusion_id: "glob-gone",
          customer_id: 7,
          attempt_count: 0,
        },
      ],
      global: null,
    });
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => fn(auth),
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result.completed).toBe(1);
    expect(auth.jobsById.get("job-orphan")?.status).toBe("completed");
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
    expect(mockAuditLogRecord).not.toHaveBeenCalled();
  });
});

describe("runFanoutSweep — global deleted between initial load and tenant DELETE", () => {
  // Round-3 race: the worker loads the global row, then the operator
  // deletes it before the tenant transaction acquires the cadence
  // lock. The cascade has already removed our job row; the worker
  // must NOT issue tenant DELETEs against rows the active set no
  // longer excludes.
  it("re-checks the global row after acquiring the cadence lock and skips tenant DELETE if it is gone", async () => {
    let globalLookupCount = 0;
    const auth = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("milliseconds")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          return {
            rows: [
              {
                id: "job-race",
                global_exclusion_id: "glob-race",
                customer_id: 9,
                attempt_count: 0,
              },
            ],
            rowCount: 1,
          };
        }
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("status = 'running'")
        ) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM global_triage_exclusion")) {
          globalLookupCount += 1;
          // First load: row exists. Second load (recheck after lock):
          // row was deleted between the two reads.
          if (globalLookupCount === 1) {
            return {
              rows: [
                {
                  id: "glob-race",
                  kind: "hostname",
                  value: "race.example",
                  domain_suffix: null,
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("UPDATE triage_exclusion_fanout_job") &&
          sql.includes("status = 'completed'")
        ) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const tenant = makeTenantPool();
    mockGetCustomerPool.mockResolvedValue(tenant.pool);
    let withTxCallCount = 0;
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => {
        withTxCallCount += 1;
        return fn(auth);
      },
    );

    const result = await runFanoutSweep({ batchSize: 5 });

    expect(result.completed).toBe(1);
    // The recheck happened (two global lookups, one for the initial
    // load and one inside the tenant transaction).
    expect(globalLookupCount).toBeGreaterThanOrEqual(2);
    // The tenant transaction issued BEGIN + ROLLBACK (NOT COMMIT) and
    // never reached a DELETE statement: the recheck short-circuited
    // before the first batch ran.
    const tenantSqls = tenant.tenantQueries.map((q) => q.sql);
    expect(tenantSqls).toContain("BEGIN");
    expect(tenantSqls).toContain("ROLLBACK");
    expect(tenantSqls.some((s) => s.startsWith("DELETE"))).toBe(false);
    // No customer_add audit row — there was no work to attribute.
    expect(mockAuditLogRecord).not.toHaveBeenCalled();
    // Sanity: the job row finalized as completed (no-op).
    expect(withTxCallCount).toBeGreaterThan(0);
  });
});
