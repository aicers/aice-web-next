import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import {
  DEFAULT_DELETE_BATCH_SIZE,
  runEngagementRetentionDispatch,
  runEngagementRetentionForCustomer,
  verifyTriageEngagementRetentionToken,
} from "@/lib/triage/engagement/retention";
import {
  ENGAGEMENT_ACTION_RETENTION_DAYS,
  ENGAGEMENT_IMPRESSION_RETENTION_DAYS,
} from "@/lib/triage/engagement/types";

interface DeleteCall {
  table: string;
  retentionDays: string;
}

function makePool(opts: { rowsByTable?: Record<string, number[]> }) {
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

describe("runEngagementRetentionForCustomer", () => {
  it("sweeps both engagement tables with their documented retention windows", async () => {
    const { pool, calls } = makePool({
      rowsByTable: {
        engagement_impression: [12],
        engagement_action: [4],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runEngagementRetentionForCustomer(7);

    expect(counts).toEqual({
      engagementImpression: 12,
      engagementAction: 4,
    });
    expect(calls).toEqual([
      {
        table: "engagement_impression",
        retentionDays: String(ENGAGEMENT_IMPRESSION_RETENTION_DAYS),
      },
      {
        table: "engagement_action",
        retentionDays: String(ENGAGEMENT_ACTION_RETENTION_DAYS),
      },
    ]);
  });

  it("loops until a partial batch confirms the table is drained", async () => {
    const { pool, calls } = makePool({
      rowsByTable: {
        engagement_impression: [
          DEFAULT_DELETE_BATCH_SIZE,
          DEFAULT_DELETE_BATCH_SIZE,
          21,
        ],
        engagement_action: [0],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runEngagementRetentionForCustomer(1);

    expect(counts.engagementImpression).toBe(
      DEFAULT_DELETE_BATCH_SIZE * 2 + 21,
    );
    expect(counts.engagementAction).toBe(0);
    const impressionCalls = calls.filter(
      (c) => c.table === "engagement_impression",
    );
    expect(impressionCalls).toHaveLength(3);
    const actionCalls = calls.filter((c) => c.table === "engagement_action");
    expect(actionCalls).toHaveLength(1);
  });
});

describe("runEngagementRetentionDispatch", () => {
  it("returns overall='ok' when every per-customer sweep succeeds", async () => {
    const result = await runEngagementRetentionDispatch({
      listActiveCustomers: async () => [1, 2],
      runForCustomer: async (id) => ({
        engagementImpression: id * 10,
        engagementAction: id,
      }),
    });

    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toEqual([
      {
        customerId: 1,
        status: "ok",
        counts: { engagementImpression: 10, engagementAction: 1 },
      },
      {
        customerId: 2,
        status: "ok",
        counts: { engagementImpression: 20, engagementAction: 2 },
      },
    ]);
  });

  it("captures a per-customer error and surfaces overall='partial' without aborting others", async () => {
    const result = await runEngagementRetentionDispatch({
      listActiveCustomers: async () => [1, 2, 3],
      runForCustomer: async (id) => {
        if (id === 2) throw new Error("tenant 2 unreachable");
        return { engagementImpression: 5, engagementAction: 1 };
      },
    });

    expect(result.overall).toBe("partial");
    expect(result.perCustomer).toEqual([
      {
        customerId: 1,
        status: "ok",
        counts: { engagementImpression: 5, engagementAction: 1 },
      },
      {
        customerId: 2,
        status: "failed",
        counts: { engagementImpression: 0, engagementAction: 0 },
        error: "tenant 2 unreachable",
      },
      {
        customerId: 3,
        status: "ok",
        counts: { engagementImpression: 5, engagementAction: 1 },
      },
    ]);
  });

  it("propagates dispatcher-level failures from the enumerator", async () => {
    await expect(
      runEngagementRetentionDispatch({
        listActiveCustomers: async () => {
          throw new Error("auth_db unreachable");
        },
      }),
    ).rejects.toThrow("auth_db unreachable");
  });

  it("returns overall='ok' with an empty perCustomer list when no customers are active", async () => {
    const result = await runEngagementRetentionDispatch({
      listActiveCustomers: async () => [],
    });

    expect(result).toEqual({ overall: "ok", perCustomer: [] });
  });
});

describe("verifyTriageEngagementRetentionToken", () => {
  const ENV_KEY = "TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN";
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
    expect(verifyTriageEngagementRetentionToken("anything")).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageEngagementRetentionToken("secret-token")).toBe(true);
  });

  it("rejects same-length mismatch (constant-time)", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageEngagementRetentionToken("secret-tokeX")).toBe(false);
  });

  it("rejects when no token provided", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyTriageEngagementRetentionToken(null)).toBe(false);
  });
});
