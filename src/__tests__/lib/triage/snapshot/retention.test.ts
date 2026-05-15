import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import {
  EXCLUSION_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS,
  POLICY_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS,
  runSnapshotRetentionDispatch,
  runSnapshotRetentionForCustomer,
  SNAPSHOT_GRACE_DAYS,
  verifyTriageSnapshotRetentionToken,
} from "@/lib/triage/snapshot/retention";

interface DeleteCall {
  table: string;
  graceDays: string;
}

function makePool(opts: { rowsByTable?: Record<string, number[]> }) {
  const calls: DeleteCall[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const table = sql.match(/DELETE FROM (\w+)/)?.[1] ?? "?";
      calls.push({ table, graceDays: params[0] as string });
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

beforeEach(() => {
  mockGetCustomerPool.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runSnapshotRetentionForCustomer", () => {
  it("sweeps exclusion_snapshot and policy_snapshot with the right grace cutoffs", async () => {
    const { pool, calls } = makePool({
      rowsByTable: {
        exclusion_snapshot: [3],
        policy_snapshot: [5],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runSnapshotRetentionForCustomer(1);

    expect(counts).toEqual({
      exclusionSnapshotsPruned: 3,
      policySnapshotsPruned: 5,
    });
    expect(calls).toEqual([
      {
        table: "exclusion_snapshot",
        graceDays: String(
          EXCLUSION_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS + SNAPSHOT_GRACE_DAYS,
        ),
      },
      {
        table: "policy_snapshot",
        graceDays: String(
          POLICY_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS + SNAPSHOT_GRACE_DAYS,
        ),
      },
    ]);
  });

  it("does NOT touch baseline_version_snapshot (retained forever)", async () => {
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    await runSnapshotRetentionForCustomer(1);
    expect(calls.find((c) => c.table === "baseline_version_snapshot")).toBe(
      undefined,
    );
  });

  it("sweep predicates require both corpora's reference probes (NOT EXISTS on both tables)", async () => {
    const { pool } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    await runSnapshotRetentionForCustomer(42);
    // Exclusion snapshot probe joins against both corpus tables.
    const exclusionDelete = pool.query.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM exclusion_snapshot"),
    );
    expect(exclusionDelete?.[0]).toContain("baseline_triaged_event");
    expect(exclusionDelete?.[0]).toContain("policy_triage_run");
    // Policy snapshot probe is single-sided.
    const policyDelete = pool.query.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM policy_snapshot"),
    );
    expect(policyDelete?.[0]).toContain("policy_triage_run");
    expect(policyDelete?.[0]).not.toContain("baseline_triaged_event");
  });
});

describe("runSnapshotRetentionDispatch", () => {
  it("collects per-customer outcomes and marks `partial` on a single failure", async () => {
    const result = await runSnapshotRetentionDispatch({
      listActiveCustomers: async () => [1, 2, 3],
      runForCustomer: async (customerId) => {
        if (customerId === 2) {
          throw new Error("boom");
        }
        return { exclusionSnapshotsPruned: 1, policySnapshotsPruned: 0 };
      },
    });
    expect(result.overall).toBe("partial");
    expect(result.perCustomer).toHaveLength(3);
    expect(result.perCustomer[1]).toMatchObject({
      customerId: 2,
      status: "failed",
      error: "boom",
    });
  });

  it("returns `ok` when every customer succeeds", async () => {
    const result = await runSnapshotRetentionDispatch({
      listActiveCustomers: async () => [1, 2],
      runForCustomer: async () => ({
        exclusionSnapshotsPruned: 0,
        policySnapshotsPruned: 0,
      }),
    });
    expect(result.overall).toBe("ok");
  });
});

describe("verifyTriageSnapshotRetentionToken", () => {
  it("refuses when the env var is unset", () => {
    vi.stubEnv("TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN", "");
    expect(verifyTriageSnapshotRetentionToken("anything")).toBe(false);
  });

  it("refuses on length mismatch (timing-safe)", () => {
    vi.stubEnv("TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN", "abc123");
    expect(verifyTriageSnapshotRetentionToken("abc124xxxx")).toBe(false);
  });

  it("accepts the exact token", () => {
    vi.stubEnv(
      "TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN",
      "shared-secret-for-tests",
    );
    expect(verifyTriageSnapshotRetentionToken("shared-secret-for-tests")).toBe(
      true,
    );
  });
});
