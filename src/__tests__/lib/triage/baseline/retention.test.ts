import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import {
  BASELINE_TRIAGED_EVENT_RETENTION_DAYS,
  DEFAULT_DELETE_BATCH_SIZE,
  OBSERVED_EVENT_META_RETENTION_DAYS,
  runBaselineRetentionDispatch,
  runBaselineRetentionForCustomer,
  verifyTriageBaselineRetentionToken,
} from "@/lib/triage/baseline/retention";

interface DeleteCall {
  table: string;
  retentionDays: string;
}

function makePool(opts: {
  // Returned rowCount per consecutive DELETE invocation on a given table.
  // The retention loop breaks when rowCount < batchSize.
  rowsByTable?: Record<string, number[]>;
}) {
  const calls: DeleteCall[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const table = sql.match(/DELETE FROM (\w+)/)?.[1] ?? "?";
      calls.push({ table, retentionDays: params[0] as string });
      const queue = opts.rowsByTable?.[table];
      if (!queue || queue.length === 0) {
        return { rows: [], rowCount: 0 };
      }
      const next = queue.shift() ?? 0;
      return { rows: [], rowCount: next };
    }),
  };
  return { pool, calls };
}

describe("runBaselineRetentionForCustomer", () => {
  it("sweeps both corpus A tables with their documented retention windows", async () => {
    const { pool, calls } = makePool({
      rowsByTable: {
        baseline_triaged_event: [10],
        observed_event_meta: [3],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runBaselineRetentionForCustomer(7);

    expect(counts).toEqual({
      baselineTriagedEvent: 10,
      observedEventMeta: 3,
    });
    // Both tables visited with the documented retention windows.
    expect(calls).toEqual([
      {
        table: "baseline_triaged_event",
        retentionDays: String(BASELINE_TRIAGED_EVENT_RETENTION_DAYS),
      },
      {
        table: "observed_event_meta",
        retentionDays: String(OBSERVED_EVENT_META_RETENTION_DAYS),
      },
    ]);
  });

  it("loops until a partial batch confirms the table is drained", async () => {
    // Two full batches of 10_000, then a partial batch ends the loop.
    const { pool, calls } = makePool({
      rowsByTable: {
        baseline_triaged_event: [
          DEFAULT_DELETE_BATCH_SIZE,
          DEFAULT_DELETE_BATCH_SIZE,
          17,
        ],
        observed_event_meta: [0],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runBaselineRetentionForCustomer(1);

    expect(counts.baselineTriagedEvent).toBe(
      DEFAULT_DELETE_BATCH_SIZE * 2 + 17,
    );
    expect(counts.observedEventMeta).toBe(0);
    // Loop terminates promptly when the table is empty.
    const baselineCalls = calls.filter(
      (c) => c.table === "baseline_triaged_event",
    );
    expect(baselineCalls).toHaveLength(3);
    const observedCalls = calls.filter(
      (c) => c.table === "observed_event_meta",
    );
    expect(observedCalls).toHaveLength(1);
  });
});

describe("runBaselineRetentionDispatch", () => {
  it("returns overall='ok' when every per-customer sweep succeeds", async () => {
    const result = await runBaselineRetentionDispatch({
      listActiveCustomers: async () => [1, 2],
      runForCustomer: async (id) => ({
        baselineTriagedEvent: id * 10,
        observedEventMeta: id,
      }),
    });

    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toEqual([
      {
        customerId: 1,
        status: "ok",
        counts: { baselineTriagedEvent: 10, observedEventMeta: 1 },
      },
      {
        customerId: 2,
        status: "ok",
        counts: { baselineTriagedEvent: 20, observedEventMeta: 2 },
      },
    ]);
  });

  it("captures a per-customer error and surfaces overall='partial' without aborting others", async () => {
    const result = await runBaselineRetentionDispatch({
      listActiveCustomers: async () => [1, 2, 3],
      runForCustomer: async (id) => {
        if (id === 2) throw new Error("tenant 2 unreachable");
        return {
          baselineTriagedEvent: 5,
          observedEventMeta: 1,
        };
      },
    });

    expect(result.overall).toBe("partial");
    expect(result.perCustomer).toEqual([
      {
        customerId: 1,
        status: "ok",
        counts: { baselineTriagedEvent: 5, observedEventMeta: 1 },
      },
      {
        customerId: 2,
        status: "failed",
        counts: { baselineTriagedEvent: 0, observedEventMeta: 0 },
        error: "tenant 2 unreachable",
      },
      {
        customerId: 3,
        status: "ok",
        counts: { baselineTriagedEvent: 5, observedEventMeta: 1 },
      },
    ]);
  });

  it("propagates dispatcher-level failures from the enumerator", async () => {
    await expect(
      runBaselineRetentionDispatch({
        listActiveCustomers: async () => {
          throw new Error("auth_db unreachable");
        },
      }),
    ).rejects.toThrow("auth_db unreachable");
  });

  it("returns overall='ok' with an empty perCustomer list when no customers are active", async () => {
    const result = await runBaselineRetentionDispatch({
      listActiveCustomers: async () => [],
    });

    expect(result).toEqual({ overall: "ok", perCustomer: [] });
  });
});

describe("verifyTriageBaselineRetentionToken", () => {
  const ENV_KEY = "TRIAGE_BASELINE_RETENTION_INTERNAL_TOKEN";
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
    expect(verifyTriageBaselineRetentionToken("anything")).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageBaselineRetentionToken("secret-token")).toBe(true);
  });

  it("rejects same-length mismatch (constant-time)", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageBaselineRetentionToken("secret-tokeX")).toBe(false);
  });
});
