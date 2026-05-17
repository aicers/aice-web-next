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
  MANUAL_MINT_RETENTION_HOURS,
  runManualMintRetentionDispatch,
  runManualMintRetentionForCustomer,
  verifyAimerPhase2ManualMintRetentionToken,
} from "@/lib/aimer/phase2/manual-mint-retention";

function makePool(opts: { rowCounts: number[] }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queue = [...opts.rowCounts];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const n = queue.shift() ?? 0;
      return { rows: [], rowCount: n };
    }),
  };
  return { pool, calls };
}

describe("runManualMintRetentionForCustomer", () => {
  it("sweeps `aimer_phase2_manual_mint` with the documented 24h window", async () => {
    const { pool, calls } = makePool({ rowCounts: [3] });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runManualMintRetentionForCustomer(7);

    expect(counts).toEqual({ pruned: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("DELETE FROM aimer_phase2_manual_mint");
    expect(calls[0].sql).toContain("minted_at <");
    expect(calls[0].params[0]).toBe(String(MANUAL_MINT_RETENTION_HOURS));
  });

  it("loops until a partial batch confirms the table is drained", async () => {
    const { pool, calls } = makePool({
      rowCounts: [DEFAULT_DELETE_BATCH_SIZE, DEFAULT_DELETE_BATCH_SIZE, 11],
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runManualMintRetentionForCustomer(1);

    expect(counts.pruned).toBe(DEFAULT_DELETE_BATCH_SIZE * 2 + 11);
    expect(calls).toHaveLength(3);
  });
});

describe("runManualMintRetentionDispatch", () => {
  it("returns overall='ok' when every per-customer sweep succeeds", async () => {
    const result = await runManualMintRetentionDispatch({
      listActiveCustomers: async () => [1, 2],
      runForCustomer: async (id) => ({ pruned: id }),
    });

    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toEqual([
      { customerId: 1, status: "ok", counts: { pruned: 1 } },
      { customerId: 2, status: "ok", counts: { pruned: 2 } },
    ]);
  });

  it("captures a per-customer error and surfaces overall='partial' without aborting others", async () => {
    const result = await runManualMintRetentionDispatch({
      listActiveCustomers: async () => [1, 2, 3],
      runForCustomer: async (id) => {
        if (id === 2) throw new Error("tenant 2 unreachable");
        return { pruned: 5 };
      },
    });

    expect(result.overall).toBe("partial");
    expect(result.perCustomer).toEqual([
      { customerId: 1, status: "ok", counts: { pruned: 5 } },
      {
        customerId: 2,
        status: "failed",
        counts: { pruned: 0 },
        error: "tenant 2 unreachable",
      },
      { customerId: 3, status: "ok", counts: { pruned: 5 } },
    ]);
  });

  it("propagates dispatcher-level failures from the enumerator", async () => {
    await expect(
      runManualMintRetentionDispatch({
        listActiveCustomers: async () => {
          throw new Error("auth_db unreachable");
        },
      }),
    ).rejects.toThrow("auth_db unreachable");
  });

  it("returns overall='ok' with an empty perCustomer list when no customers are active", async () => {
    const result = await runManualMintRetentionDispatch({
      listActiveCustomers: async () => [],
    });

    expect(result).toEqual({ overall: "ok", perCustomer: [] });
  });
});

describe("verifyAimerPhase2ManualMintRetentionToken", () => {
  const ENV_KEY = "AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN";
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
    expect(verifyAimerPhase2ManualMintRetentionToken("anything")).toBe(false);
  });

  it("accepts the matching token", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyAimerPhase2ManualMintRetentionToken("secret-token")).toBe(
      true,
    );
  });

  it("rejects same-length mismatch (constant-time)", () => {
    process.env[ENV_KEY] = "secret-token";
    expect(verifyAimerPhase2ManualMintRetentionToken("secret-tokeX")).toBe(
      false,
    );
  });
});
