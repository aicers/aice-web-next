import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuditLogRecord = vi.hoisted(() =>
  vi.fn(async (_payload: Record<string, unknown>) => undefined),
);
const mockWithTransaction = vi.hoisted(() =>
  vi.fn(
    async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn((globalThis as Record<string, unknown>).__client__),
  ),
);

vi.mock("@/lib/db/client", () => ({
  withTransaction: mockWithTransaction,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditLogRecord },
}));

import {
  applyRecover,
  emitRecoverAudit,
  insertCustomerDrainFailureSentinel,
  resetAllGlobalFailedJobs,
  resetCustomerDrainSentinel,
  resetGlobalFanoutJob,
  verifyTriageExclusionRecoveryToken,
} from "@/lib/triage/exclusion/recovery";

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeClient(opts: { affected: number } = { affected: 0 }) {
  const queries: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: opts.affected };
  });
  return { queries, query };
}

describe("resetGlobalFanoutJob", () => {
  it("issues a single-row UPDATE keyed by (global_exclusion_id, customer_id, status='failed')", async () => {
    const client = makeClient({ affected: 1 });

    const n = await resetGlobalFanoutJob(
      client as unknown as Parameters<typeof resetGlobalFanoutJob>[0],
      "glob-1",
      7,
    );

    expect(n).toBe(1);
    expect(client.queries).toHaveLength(1);
    const { sql, params } = client.queries[0];
    expect(sql).toContain("UPDATE triage_exclusion_fanout_job");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("attempt_count = 0");
    expect(sql).toContain("last_error = NULL");
    expect(sql).toContain("WHERE global_exclusion_id = $1");
    expect(sql).toContain("AND customer_id = $2");
    expect(sql).toContain("AND status = 'failed'");
    expect(params).toEqual(["glob-1", 7]);
  });

  it("returns 0 when no failed row matches", async () => {
    const client = makeClient({ affected: 0 });
    const n = await resetGlobalFanoutJob(
      client as unknown as Parameters<typeof resetGlobalFanoutJob>[0],
      "glob-missing",
      7,
    );
    expect(n).toBe(0);
  });
});

describe("resetAllGlobalFailedJobs", () => {
  it("sweeps every failed row for one global exclusion (no customer_id predicate)", async () => {
    const client = makeClient({ affected: 12 });

    const n = await resetAllGlobalFailedJobs(
      client as unknown as Parameters<typeof resetAllGlobalFailedJobs>[0],
      "glob-1",
    );

    expect(n).toBe(12);
    const { sql, params } = client.queries[0];
    expect(sql).toContain("WHERE global_exclusion_id = $1");
    expect(sql).not.toContain("customer_id");
    expect(sql).toContain("AND status = 'failed'");
    expect(params).toEqual(["glob-1"]);
  });
});

describe("resetCustomerDrainSentinel", () => {
  it("issues an UPDATE keyed by (customer_only_exclusion_id, customer_id, status='failed')", async () => {
    const client = makeClient({ affected: 1 });

    const n = await resetCustomerDrainSentinel(
      client as unknown as Parameters<typeof resetCustomerDrainSentinel>[0],
      "exc-1",
      42,
    );

    expect(n).toBe(1);
    const { sql, params } = client.queries[0];
    expect(sql).toContain("UPDATE triage_exclusion_fanout_job");
    expect(sql).toContain("WHERE customer_only_exclusion_id = $1");
    expect(sql).toContain("AND customer_id = $2");
    expect(sql).toContain("AND status = 'failed'");
    expect(params).toEqual(["exc-1", 42]);
  });
});

describe("insertCustomerDrainFailureSentinel", () => {
  it("INSERTs a failed sentinel with attempt_count=MAX_ATTEMPTS and ON CONFLICT upsert", async () => {
    const client = makeClient({ affected: 1 });

    await insertCustomerDrainFailureSentinel(
      client as unknown as Parameters<
        typeof insertCustomerDrainFailureSentinel
      >[0],
      "exc-1",
      42,
      "drain phase failed: tenant DB timeout",
    );

    expect(client.queries).toHaveLength(1);
    const { sql, params } = client.queries[0];
    expect(sql).toContain("INSERT INTO triage_exclusion_fanout_job");
    // Sentinel: global_exclusion_id is NULL, status='failed'.
    expect(sql).toContain("NULL, $1, $2, 'failed'");
    // ON CONFLICT keyed on the customer-only partial index.
    expect(sql).toContain(
      "ON CONFLICT (customer_only_exclusion_id, customer_id)",
    );
    expect(sql).toContain("WHERE customer_only_exclusion_id IS NOT NULL");
    expect(sql).toContain("DO UPDATE SET");
    expect(sql).toContain("status = 'failed'");
    // The DO UPDATE resets next_attempt_at / claimed_at so admin recovery
    // can reset-in-place.
    expect(sql).toContain("next_attempt_at = NOW()");
    expect(sql).toContain("claimed_at = NULL");
    expect(params).toEqual([
      "exc-1",
      42,
      5, // MAX_ATTEMPTS
      "drain phase failed: tenant DB timeout",
    ]);
  });
});

describe("applyRecover", () => {
  beforeEach(() => {
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(
      async <T>(fn: (c: unknown) => Promise<T>) =>
        fn((globalThis as Record<string, unknown>).__client__),
    );
  });

  it("dispatches kind='global' to the single-row global reset", async () => {
    const client = makeClient({ affected: 1 });
    (globalThis as Record<string, unknown>).__client__ = client;

    const outcome = await applyRecover({
      kind: "global",
      exclusionId: "glob-1",
      customerId: 7,
    });

    expect(outcome).toEqual({ reset: 1, kind: "global" });
    const { sql, params } = client.queries[0];
    expect(sql).toContain("WHERE global_exclusion_id = $1");
    expect(sql).toContain("AND customer_id = $2");
    expect(params).toEqual(["glob-1", 7]);
  });

  it("dispatches kind='global_all_failed' to the sweep reset (no customer_id)", async () => {
    const client = makeClient({ affected: 5 });
    (globalThis as Record<string, unknown>).__client__ = client;

    const outcome = await applyRecover({
      kind: "global_all_failed",
      exclusionId: "glob-1",
    });

    expect(outcome).toEqual({ reset: 5, kind: "global_all_failed" });
    const { sql, params } = client.queries[0];
    expect(sql).toContain("WHERE global_exclusion_id = $1");
    expect(sql).not.toContain("customer_id");
    expect(params).toEqual(["glob-1"]);
  });

  it("dispatches kind='customer' to the customer-only sentinel reset", async () => {
    const client = makeClient({ affected: 1 });
    (globalThis as Record<string, unknown>).__client__ = client;

    const outcome = await applyRecover({
      kind: "customer",
      exclusionId: "exc-1",
      customerId: 42,
    });

    expect(outcome).toEqual({ reset: 1, kind: "customer" });
    const { sql, params } = client.queries[0];
    expect(sql).toContain("WHERE customer_only_exclusion_id = $1");
    expect(sql).toContain("AND customer_id = $2");
    expect(params).toEqual(["exc-1", 42]);
  });
});

describe("emitRecoverAudit", () => {
  beforeEach(() => {
    mockAuditLogRecord.mockReset();
  });

  it("emits triage_exclusion.global_recover (customer-agnostic) for kind='global'", async () => {
    await emitRecoverAudit(
      { kind: "global", exclusionId: "glob-1", customerId: 7 },
      "admin@example.com",
      1,
      { ip: "10.0.0.1", sid: "sess-1" },
    );

    expect(mockAuditLogRecord).toHaveBeenCalledTimes(1);
    const payload = mockAuditLogRecord.mock.calls[0][0];
    expect(payload).toMatchObject({
      actor: "admin@example.com",
      action: "triage_exclusion.global_recover",
      target: "triage_exclusion",
      targetId: "glob-1",
      ip: "10.0.0.1",
      sid: "sess-1",
    });
    // customer-agnostic action: top-level customerId is NOT populated.
    expect(payload.customerId).toBeUndefined();
    // Details still record the per-customer hint for the audit viewer.
    expect(payload.details).toMatchObject({
      id: "glob-1",
      kind: "global",
      customerId: 7,
      reset: 1,
    });
  });

  it("emits triage_exclusion.global_recover with customerId=null for kind='global_all_failed'", async () => {
    await emitRecoverAudit(
      { kind: "global_all_failed", exclusionId: "glob-1" },
      "system",
      9,
    );

    const payload = mockAuditLogRecord.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: "triage_exclusion.global_recover",
      targetId: "glob-1",
    });
    expect(payload.customerId).toBeUndefined();
    expect(payload.details).toMatchObject({
      kind: "global_all_failed",
      customerId: null,
      reset: 9,
    });
  });

  it("emits triage_exclusion.customer_recover (customer-scoped) for kind='customer'", async () => {
    await emitRecoverAudit(
      { kind: "customer", exclusionId: "exc-1", customerId: 42 },
      "admin@example.com",
      1,
    );

    const payload = mockAuditLogRecord.mock.calls[0][0];
    expect(payload).toMatchObject({
      actor: "admin@example.com",
      action: "triage_exclusion.customer_recover",
      target: "triage_exclusion",
      targetId: "exc-1",
      customerId: 42,
      details: { id: "exc-1", kind: "customer", reset: 1 },
    });
  });
});

describe("verifyTriageExclusionRecoveryToken", () => {
  const ENV_KEY = "TRIAGE_EXCLUSION_RECOVERY_INTERNAL_TOKEN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("rejects when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(verifyTriageExclusionRecoveryToken("anything")).toBe(false);
  });

  it("rejects null", () => {
    process.env[ENV_KEY] = "secret";
    expect(verifyTriageExclusionRecoveryToken(null)).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageExclusionRecoveryToken("secret-token")).toBe(true);
  });

  it("rejects a length-mismatched token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageExclusionRecoveryToken("short")).toBe(false);
  });

  it("rejects a same-length but different token (constant-time compare)", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageExclusionRecoveryToken("secret-tokeX")).toBe(false);
  });
});
