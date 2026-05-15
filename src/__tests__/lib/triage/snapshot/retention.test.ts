import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import {
  runSnapshotRetentionDispatch,
  runSnapshotRetentionForCustomer,
  SNAPSHOT_GRACE_DAYS,
  verifyTriageSnapshotRetentionToken,
} from "@/lib/triage/snapshot/retention";

type Phase = "mark" | "revive" | "delete";

interface SqlCall {
  table: "exclusion_snapshot" | "policy_snapshot" | "other";
  phase: Phase;
  params: unknown[];
  sql: string;
}

function classify(sql: string): { table: SqlCall["table"]; phase: Phase } {
  const trimmed = sql.trim();
  const table = trimmed.includes("exclusion_snapshot")
    ? "exclusion_snapshot"
    : trimmed.includes("policy_snapshot")
      ? "policy_snapshot"
      : "other";
  if (trimmed.startsWith("UPDATE")) {
    if (trimmed.includes("SET unreferenced_since = NOW()")) {
      return { table, phase: "mark" };
    }
    if (trimmed.includes("SET unreferenced_since = NULL")) {
      return { table, phase: "revive" };
    }
  }
  return { table, phase: "delete" };
}

function makePool(opts: {
  rowsByCall?: Partial<Record<`${SqlCall["table"]}:${Phase}`, number[]>>;
}) {
  const calls: SqlCall[] = [];
  const queues: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(opts.rowsByCall ?? {})) {
    queues[k] = [...(v as number[])];
  }
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const { table, phase } = classify(sql);
      calls.push({ table, phase, params, sql });
      const key = `${table}:${phase}`;
      const queue = queues[key];
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
  it("runs mark / revive / delete in order against both snapshot tables", async () => {
    const { pool, calls } = makePool({
      rowsByCall: {
        "exclusion_snapshot:mark": [3],
        "exclusion_snapshot:revive": [1],
        "exclusion_snapshot:delete": [2],
        "policy_snapshot:mark": [5],
        "policy_snapshot:revive": [0],
        "policy_snapshot:delete": [4],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    const counts = await runSnapshotRetentionForCustomer(1);

    expect(counts).toEqual({
      exclusionSnapshotsTombstoned: 3,
      exclusionSnapshotsRevived: 1,
      exclusionSnapshotsPruned: 2,
      policySnapshotsTombstoned: 5,
      policySnapshotsRevived: 0,
      policySnapshotsPruned: 4,
    });

    // Exclusion table sweeps before policy table; within each table
    // the phases are mark -> revive -> delete.
    const phasesFor = (t: SqlCall["table"]) =>
      calls.filter((c) => c.table === t).map((c) => c.phase);
    expect(phasesFor("exclusion_snapshot")).toEqual([
      "mark",
      "revive",
      "delete",
    ]);
    expect(phasesFor("policy_snapshot")).toEqual(["mark", "revive", "delete"]);
  });

  it("delete-phase grace cutoff is the 30-day tombstone window, not corpus-window+grace", async () => {
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    await runSnapshotRetentionForCustomer(1);

    // Captures the #472 review fix: the cutoff parameter must be the
    // grace period itself (gated against `unreferenced_since`), not
    // corpus retention + grace (gated against the fixed `captured_at`).
    // Otherwise long-lived fingerprints whose references age out
    // after `captured_at + corpus_window` would be pruned with no
    // post-expiration grace.
    expect(SNAPSHOT_GRACE_DAYS).toBe(30);
    const deleteCalls = calls.filter((c) => c.phase === "delete");
    expect(deleteCalls).toHaveLength(2);
    for (const call of deleteCalls) {
      expect(call.params[0]).toBe(String(SNAPSHOT_GRACE_DAYS));
    }
  });

  it("delete-phase predicate gates on unreferenced_since, NOT captured_at", async () => {
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);

    await runSnapshotRetentionForCustomer(1);

    const deleteCalls = calls.filter((c) => c.phase === "delete");
    for (const call of deleteCalls) {
      expect(call.sql).toContain("unreferenced_since IS NOT NULL");
      expect(call.sql).toContain("unreferenced_since <");
      expect(call.sql).not.toContain("captured_at <");
    }
  });

  it("mark-phase requires NO references in both corpora for exclusion snapshots", async () => {
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    await runSnapshotRetentionForCustomer(42);

    const exclusionMark = calls.find(
      (c) => c.table === "exclusion_snapshot" && c.phase === "mark",
    );
    expect(exclusionMark?.sql).toContain("baseline_triaged_event");
    expect(exclusionMark?.sql).toContain("policy_triage_run");

    // Policy mark is single-sided — only policy_triage_run.
    const policyMark = calls.find(
      (c) => c.table === "policy_snapshot" && c.phase === "mark",
    );
    expect(policyMark?.sql).toContain("policy_triage_run");
    expect(policyMark?.sql).not.toContain("baseline_triaged_event");
  });

  it("revive-phase clears the tombstone if EITHER corpus rereferences an exclusion fingerprint", async () => {
    // A stable exclusion set can re-mint the same fingerprint after
    // an earlier reference aged out. The revive phase undoes a
    // previous tombstone so the grace clock resets to the new
    // reference's eventual aging-out.
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    await runSnapshotRetentionForCustomer(1);

    const exclusionRevive = calls.find(
      (c) => c.table === "exclusion_snapshot" && c.phase === "revive",
    );
    expect(exclusionRevive?.sql).toContain("unreferenced_since IS NOT NULL");
    expect(exclusionRevive?.sql).toMatch(/baseline_triaged_event[\s\S]*OR/);
    expect(exclusionRevive?.sql).toContain("policy_triage_run");
  });

  it("does NOT touch baseline_version_snapshot (retained forever)", async () => {
    const { pool, calls } = makePool({});
    mockGetCustomerPool.mockResolvedValueOnce(pool);
    await runSnapshotRetentionForCustomer(1);
    expect(calls.find((c) => c.sql.includes("baseline_version_snapshot"))).toBe(
      undefined,
    );
  });

  it("two-sweep timeline: first sweep tombstones, second sweep (within grace) does not delete", async () => {
    // Models the reused-fingerprint case from the #472 review: a
    // long-lived fingerprint whose last reference ages out today.
    // First sweep finds zero references => mark. Second sweep, run
    // before the 30-day grace elapses, must NOT delete the row.
    // We model "grace not yet elapsed" by leaving the delete queue
    // empty (no row qualifies), confirming the test infra exercises
    // the predicate path that returns zero.
    const first = makePool({
      rowsByCall: {
        "exclusion_snapshot:mark": [1],
        "exclusion_snapshot:revive": [0],
        "exclusion_snapshot:delete": [0],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(first.pool);
    const firstCounts = await runSnapshotRetentionForCustomer(1);
    expect(firstCounts.exclusionSnapshotsTombstoned).toBe(1);
    expect(firstCounts.exclusionSnapshotsPruned).toBe(0);

    // Second sweep: already tombstoned (mark returns 0), still no
    // references (revive returns 0), grace not yet elapsed
    // (delete returns 0).
    const second = makePool({
      rowsByCall: {
        "exclusion_snapshot:mark": [0],
        "exclusion_snapshot:revive": [0],
        "exclusion_snapshot:delete": [0],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(second.pool);
    const secondCounts = await runSnapshotRetentionForCustomer(1);
    expect(secondCounts.exclusionSnapshotsPruned).toBe(0);

    // Eventually, a later sweep after grace elapses: delete returns 1.
    const third = makePool({
      rowsByCall: {
        "exclusion_snapshot:mark": [0],
        "exclusion_snapshot:revive": [0],
        "exclusion_snapshot:delete": [1],
      },
    });
    mockGetCustomerPool.mockResolvedValueOnce(third.pool);
    const thirdCounts = await runSnapshotRetentionForCustomer(1);
    expect(thirdCounts.exclusionSnapshotsPruned).toBe(1);
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
        return {
          exclusionSnapshotsTombstoned: 0,
          exclusionSnapshotsRevived: 0,
          exclusionSnapshotsPruned: 1,
          policySnapshotsTombstoned: 0,
          policySnapshotsRevived: 0,
          policySnapshotsPruned: 0,
        };
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
        exclusionSnapshotsTombstoned: 0,
        exclusionSnapshotsRevived: 0,
        exclusionSnapshotsPruned: 0,
        policySnapshotsTombstoned: 0,
        policySnapshotsRevived: 0,
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
