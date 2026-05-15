import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

beforeEach(() => {
  mockQuery.mockReset();
  mockWithTransaction.mockReset();
  mockAuditRecord.mockReset();
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
  it("runs row-state sweeps, then audit recovery, then purge — the round-6 ordering — and returns per-sweep counts", async () => {
    // Round 6: audit recovery runs BEFORE purge so the audit-DB-healthy
    // case is a single-cycle recovery instead of a deferred one. The
    // row-state sweeps and the purge each get their own transaction;
    // the audit recovery sits between them and runs OUTSIDE both
    // transactions because it touches the audit DB.
    const txn1Queries: Array<{ rowCount: number }> = [
      { rowCount: 1 }, // recoverStaleLocks (row-level)
      { rowCount: 0 }, // recoverStalePerDispatchClaims (#550)
      { rowCount: 0 }, // finaliseAbandonedPostDbRows (#550)
      { rowCount: 2 }, // terminaliseExpired - pending
      { rowCount: 3 }, // terminaliseExpired - failed_retryable
    ];
    const txn2Queries: Array<{ rowCount: number }> = [
      { rowCount: 4 }, // purgeRetained
    ];
    const txn1Client = {
      query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowCount: txn1Queries.shift()?.rowCount ?? 0,
      })),
    };
    const txn2Client = {
      query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowCount: txn2Queries.shift()?.rowCount ?? 0,
      })),
    };
    mockWithTransaction
      .mockImplementationOnce(async (fn: (c: unknown) => Promise<unknown>) =>
        fn(txn1Client),
      )
      .mockImplementationOnce(async (fn: (c: unknown) => Promise<unknown>) =>
        fn(txn2Client),
      );
    // Audit-recovery pass: SELECT returns no candidates (default empty
    // case) so no auditLog.record / mark / release happens.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { runApplyAttemptCleanup } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const result = await runApplyAttemptCleanup();
    expect(result).toEqual({
      recovered: 1,
      expired: 5,
      purged: 4,
      auditsRecovered: 0,
    });
    // Row-state txn (5 queries: row-level recovery + per-dispatch
    // recovery + abandoned-post-DB finalisation + 2 expiry sweeps),
    // then audit-recovery SELECT, then purge txn (1 query). Two
    // distinct transactions — the round-6 split — so audit recovery
    // can land before purge.
    expect(txn1Client.query).toHaveBeenCalledTimes(5);
    expect(txn2Client.query).toHaveBeenCalledTimes(1);
    expect(mockWithTransaction).toHaveBeenCalledTimes(2);
    expect(mockAuditRecord).not.toHaveBeenCalled();
    // Purge SQL exempts succeeded rows whose `node.apply` audit hasn't
    // landed yet (round 6) — without this, a prolonged audit-DB
    // outage would let `purgeRetained` hard-delete the row before
    // `recoverPendingNodeApplyAudits` could finish it.
    const purgeSql = txn2Client.query.mock.calls[0][0] as string;
    expect(purgeSql).toMatch(/DELETE FROM apply_attempts/);
    expect(purgeSql).toMatch(
      /status <> 'succeeded' OR succeeded_audit_completed_at IS NOT NULL/,
    );
  });
});

describe("recoverPendingNodeApplyAudits", () => {
  it("re-emits the audit and marks completed for a stuck `succeeded` row", async () => {
    // The candidate SELECT returns one row whose claim landed but
    // whose `completed_at` is still NULL after the staleness window.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
            {
              dispatchId: "d-ds",
              kind: "DATA_STORE",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
              new: "{frozen}",
            },
          ],
        },
      ],
      rowCount: 1,
    });
    // markNodeApplyAuditCompleted: returns rowCount 1.
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    expect(recovered).toBe(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    // The audit carries the row's actor and the persisted node id;
    // the cleanup sweep does not impersonate the system actor.
    expect(event.actor).toBe("actor-1");
    expect(event.action).toBe("node.apply");
    expect(event.target).toBe("node");
    expect(event.targetId).toBe("node-1");
    expect(event.details.appliedServices).toEqual(["DATA_STORE"]);
    // attempt_id threaded as correlationId so an operator chasing the
    // recovered emission can join it back to the source row.
    expect(event.correlationId).toBe("att-stuck");
  });

  it("forwards the persisted apply_attempts.customer_id onto the recovered audit (#387)", async () => {
    // Recovery sweep half of #387 P1 finding §3 — the candidate SELECT
    // must include `customer_id`, and a non-null value MUST be
    // forwarded to `auditLog.record({ customerId })` so the
    // audit-log viewer scopes the recovered row to the tenant operator
    // who actually owns the customer that ran the apply.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          customer_id: 5,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    await recoverPendingNodeApplyAudits();
    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toMatch(/customer_id/);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(event.customerId).toBe(5);
  });

  it("omits customerId on the recovered audit when apply_attempts.customer_id is NULL (#387)", async () => {
    // A globally-scoped caller's attempt against a node with no
    // `customerId` persists `customer_id = NULL`. The recovered audit
    // event must omit `customerId` rather than send `null`/`undefined`
    // — `audit_logs.customer_id` then stays NULL by design (no owning
    // customer to scope against).
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          customer_id: null,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    await recoverPendingNodeApplyAudits();
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(
      "customerId" in event ? event.customerId : undefined,
    ).toBeUndefined();
  });

  it("leaves the slot CLAIMED when the audit DB still rejects the insert so the next sweep can re-pick the row (round 4)", async () => {
    // Round-4 acceptance: on a non-23505 audit-DB failure during
    // recovery, the sweep MUST NOT release the slot. The candidate
    // SELECT requires `succeeded_audit_emitted_at IS NOT NULL`, so
    // releasing the slot would clear it back to NULL and remove the
    // row from every future recovery pass — permanently disabling
    // automatic recovery after a single transient cleanup-time
    // failure. Leaving the slot claimed lets the next sweep re-pick
    // the same row via the same predicate (the staleness window only
    // grows wider).
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    mockAuditRecord.mockRejectedValueOnce(new Error("audit DB still down"));

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    // Recovery did NOT count this row — markNodeApplyAuditCompleted
    // never ran. The next sweep will re-attempt because the
    // candidate SELECT predicate still matches (emitted_at IS NOT
    // NULL, completed_at IS NULL, staleness window still satisfied).
    expect(recovered).toBe(0);
    // Exactly one query: the candidate SELECT. Critically NO release
    // UPDATE — releasing here is what would permanently disable
    // future recovery. The mark UPDATE never ran because the audit
    // threw first.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toMatch(/SELECT/);
    expect(selectSql).toMatch(/succeeded_audit_emitted_at IS NOT NULL/);
  });

  it("does NOT release when markNodeApplyAuditCompleted fails after a successful insert (audit is durable, next sweep recovers via duplicate path) (round 4)", async () => {
    // Same durability hole as above: if the recovery insert succeeds
    // but `markNodeApplyAuditCompleted` then throws, the audit row is
    // already durable. Releasing the slot would remove the row from
    // future sweeps; leaving it claimed means the next sweep observes
    // the schema-level `unique_violation` on its re-INSERT and marks
    // `completed_at` via the duplicate-violation branch.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    // auditLog.record succeeds (no rejection).
    // markNodeApplyAuditCompleted throws.
    mockQuery.mockRejectedValueOnce(new Error("apply DB transiently down"));

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    // The audit insert succeeded so the audit row IS durable, but
    // because the marker UPDATE threw, the row is not counted as
    // recovered in this pass.
    expect(recovered).toBe(0);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    // SELECT candidates + markCompleted UPDATE. NO release-slot
    // UPDATE — releasing a slot whose audit row is already durable
    // is the bug round 4 closes.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const markSql = mockQuery.mock.calls[1][0] as string;
    expect(markSql).toMatch(/SET succeeded_audit_completed_at = NOW\(\)/);
  });

  it("treats a unique_violation as already-recovered: marks completed, counts the row (round 3)", async () => {
    // Round-3 acceptance: the round-2 sweep blindly re-INSERTed on
    // every candidate, which produced a duplicate `node.apply` row if
    // the original wrapper crashed AFTER inserting and BEFORE marking
    // `succeeded_audit_completed_at`. Round 3 adds a partial unique
    // index on `audit_logs(correlation_id) WHERE action = 'node.apply'`
    // and routes the resulting `unique_violation` (PG SQLSTATE 23505)
    // through the same mark-completed path. The candidate row is
    // counted as recovered (its `completed_at` lands inside this
    // pass), no release happens, and no second audit row is emitted.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-stuck",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: true,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    const dupErr = new Error(
      'duplicate key value violates unique constraint "audit_logs_node_apply_correlation_unique"',
    );
    (dupErr as Error & { code?: string }).code = "23505";
    mockAuditRecord.mockRejectedValueOnce(dupErr);
    // markNodeApplyAuditCompleted: returns rowCount 1.
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    expect(recovered).toBe(1);
    // Two queries: SELECT candidates + markCompleted UPDATE. The
    // release-slot UPDATE MUST NOT run on a duplicate violation —
    // releasing a slot whose audit row is already durable would let
    // the next sweep re-emit, get rejected again, and loop.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const markSql = mockQuery.mock.calls[1][0] as string;
    expect(markSql).toMatch(/SET succeeded_audit_completed_at = NOW\(\)/);
  });

  it("returns 0 with no candidate rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(await recoverPendingNodeApplyAudits()).toBe(0);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("candidate SELECT covers both windows: slot-claimed-but-not-completed AND slot-never-claimed (round 6)", async () => {
    // Round-6: process death between `status = 'succeeded'` commit and
    // `claimNodeApplyAuditSlot` left both audit columns NULL, and the
    // round-5 SELECT (`emitted_at IS NOT NULL`) was blind to that
    // window. Round 6 expands the predicate to ALSO match
    // `emitted_at IS NULL` rows whose `succeeded_at` (≈
    // `expires_at - retentionMs`) is older than the staleness window.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    await recoverPendingNodeApplyAudits();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'succeeded'/);
    expect(sql).toMatch(/succeeded_audit_completed_at IS NULL/);
    // Branch 1: slot claimed, completion never landed.
    expect(sql).toMatch(/succeeded_audit_emitted_at IS NOT NULL/);
    expect(sql).toMatch(
      /NOW\(\) - succeeded_audit_emitted_at > \(\$1 \|\| ' milliseconds'\)::interval/,
    );
    // Branch 2 (round 6): slot never claimed; row sat `succeeded` for
    // longer than the staleness window. `expires_at - retentionMs ≈
    // succeeded_at`, so the gate is `NOW() > succeeded_at + staleMs`.
    expect(sql).toMatch(/succeeded_audit_emitted_at IS NULL/);
    expect(sql).toMatch(
      /NOW\(\) > expires_at - \(\$2 \|\| ' milliseconds'\)::interval \+ \(\$1 \|\| ' milliseconds'\)::interval/,
    );
  });

  it("claims the slot first when SELECT returns a row with `slot_claimed = false`, then emits and marks completed (round 6)", async () => {
    // The round-6 process-death window: lifecycle committed
    // `status = 'succeeded'` but the wrapper crashed before reaching
    // `claimNodeApplyAuditSlot`. Both audit columns are NULL at SELECT
    // time. The recovery sweep MUST claim the slot itself (atomic NULL
    // → NOW() UPDATE) before emitting; otherwise a wrapper that
    // arrives concurrently could emit twice (the schema-level dedupe
    // catches that, but the slot machinery is the coordinated
    // mechanism on top of it).
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-uncaimed",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: false,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
            {
              dispatchId: "d-ds",
              kind: "DATA_STORE",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
              new: "{frozen}",
            },
          ],
        },
      ],
      rowCount: 1,
    });
    // `claimNodeApplyAuditSlot` UPDATE: rowCount 1 — we won the claim.
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // `markNodeApplyAuditCompleted`: rowCount 1.
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    expect(recovered).toBe(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(event.actor).toBe("actor-1");
    expect(event.action).toBe("node.apply");
    expect(event.targetId).toBe("node-1");
    expect(event.details.appliedServices).toEqual(["DATA_STORE"]);
    expect(event.correlationId).toBe("att-uncaimed");
    // SELECT + claim + mark — three queries on the apply DB.
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const claimSql = mockQuery.mock.calls[1][0] as string;
    expect(claimSql).toMatch(/SET succeeded_audit_emitted_at = NOW\(\)/);
    expect(claimSql).toMatch(/succeeded_audit_emitted_at IS NULL/);
  });

  it("skips a `slot_claimed = false` candidate when a wrapper claims the slot concurrently — claim returns 0 (round 6)", async () => {
    // SELECT returned a slot-unclaimed candidate, but between SELECT
    // and the recovery's claim attempt a wrapper arrived and won the
    // claim. The recovery's UPDATE matches zero rows; we MUST skip
    // emission. The wrapper is now driving the row; the next sweep
    // can recheck.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          attempt_id: "att-raced",
          node_id: "node-1",
          audit_actor: "actor-1",
          slot_claimed: false,
          planned_dispatches: [
            {
              dispatchId: "d-mgr",
              kind: "MANAGER_DB",
              state: "succeeded",
              attemptCount: 1,
              lastError: null,
            },
          ],
        },
      ],
      rowCount: 1,
    });
    // `claimNodeApplyAuditSlot` UPDATE: rowCount 0 — we lost.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    expect(recovered).toBe(0);
    // No audit emitted, no mark UPDATE.
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe("audit-emission slot helpers", () => {
  it("markNodeApplyAuditCompleted UPDATE is guarded so an unclaimed slot never flips to completed", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { markNodeApplyAuditCompleted } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(await markNodeApplyAuditCompleted("att-1")).toBe(false);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET succeeded_audit_completed_at = NOW\(\)/);
    expect(sql).toMatch(/succeeded_audit_emitted_at IS NOT NULL/);
    expect(sql).toMatch(/succeeded_audit_completed_at IS NULL/);
  });

  it("releaseNodeApplyAuditSlot is a no-op once `completed_at` is set (durability)", async () => {
    // Simulate a release racing a successful completion: the guard
    // matches zero rows because `completed_at` has been set.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { releaseNodeApplyAuditSlot } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    expect(await releaseNodeApplyAuditSlot("att-1")).toBe(false);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET succeeded_audit_emitted_at = NULL/);
    expect(sql).toMatch(/succeeded_audit_completed_at IS NULL/);
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
