import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

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

const SESSION_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";
const ATTEMPT_ID = "11111111-1111-1111-1111-111111111111";
const RETRY_DISPATCH_ID = "dd222222-2222-2222-2222-222222222222";

function makeSession(): AuthSession {
  return {
    accountId: SESSION_ACCOUNT_ID,
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: 0,
    exp: 0,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "test",
    sessionBrowserFingerprint: "test",
    needsReauth: false,
    sessionCreatedAt: new Date(0),
    sessionLastActiveAt: new Date(0),
  } as AuthSession;
}

function persistedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attempt_id: ATTEMPT_ID,
    node_id: "node-1",
    draft_fingerprint: Buffer.alloc(32),
    planned_dispatches: [
      {
        dispatchId: "dd111111-1111-1111-1111-111111111111",
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: RETRY_DISPATCH_ID,
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "x",
        new: "{a}",
      },
    ],
    created_by: SESSION_ACCOUNT_ID,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
    executing_lock: null,
    claim_started_at: null,
    status: "failed_retryable",
    ...overrides,
  };
}

describe("_internal_confirmApplyAttempt — failed_retryable is idempotent", () => {
  it("returns the persisted row unchanged when status is failed_retryable AND PG says the row is still in-window; no claim attempted; no dispatcher call", async () => {
    // Step-1 read returns the failed_retryable row.
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow()],
      rowCount: 1,
    });
    // Idempotent-return SQL-authoritative terminalise: PG agrees the
    // row is in-window, so the helper's `NOW() > expires_at` WHERE
    // matches 0 rows and we fall through to the idempotent return.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const dispatcher = {
      managerDb: vi.fn(),
      managerNotify: vi.fn(),
      external: vi.fn(),
    };
    const draftReader = { readNodeDraft: vi.fn() };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher,
      draftReader,
    });
    expect(result.status).toBe("failed_retryable");
    // Step-1 read + idempotent-return SQL-authoritative terminalise.
    // No executor and no claim transaction.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(dispatcher.managerDb).not.toHaveBeenCalled();
    expect(dispatcher.managerNotify).not.toHaveBeenCalled();
    expect(dispatcher.external).not.toHaveBeenCalled();
    expect(draftReader.readNodeDraft).not.toHaveBeenCalled();
  });

  it("surfaces StalePlanError in the same call when PG has crossed expires_at but the host clock has not yet (clock-skew gap)", async () => {
    // The reviewer's Round-4 case: a `failed_retryable` row whose
    // `expires_at` has passed per PG but not yet per the host's
    // `Date.now()`. The step-2a app-clock fast-path doesn't fire, so
    // without an extra defense the `failed_retryable` switch branch
    // would idempotently return the persisted soft-failed row. The
    // SQL-authoritative terminalise call inside that branch is what
    // turns this into a `StalePlanError` in the same call.
    const futureExpires = new Date(Date.now() + 30_000);
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ expires_at: futureExpires })],
      rowCount: 1,
    });
    // SQL-authoritative terminalise: PG decided the row is past
    // `expires_at` (NOW() > expires_at), 1 row affected.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const dispatcher = {
      managerDb: vi.fn(),
      managerNotify: vi.fn(),
      external: vi.fn(),
    };
    const draftReader = { readNodeDraft: vi.fn() };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher,
        draftReader,
      }),
    ).rejects.toThrow(/expired/);
    // Step-1 read + SQL terminalise. No claim transaction; no
    // dispatcher call; no draft reader call.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(dispatcher.managerDb).not.toHaveBeenCalled();
    expect(dispatcher.managerNotify).not.toHaveBeenCalled();
    expect(dispatcher.external).not.toHaveBeenCalled();
    expect(draftReader.readNodeDraft).not.toHaveBeenCalled();
  });

  it("still consults PG when expires_at is exactly equal to Date.now() at step 2a (boundary case — no second Date.now() snapshot)", async () => {
    // Boundary case the Round-5 review flagged. The previous shape
    // used a second `Date.now()` snapshot inside the failed_retryable
    // branch; if `expiresAt === now` at step 2a (so the `<` test fails
    // and the helper does not run) but a few ms later the second
    // snapshot ticks past expiresAt (so the `>=` test in the
    // failed_retryable branch also fails), neither branch ran the
    // SQL-authoritative helper and the row was returned idempotently.
    // The fix replaces the second Date.now() snapshot with a flag
    // tracking whether step 2a's helper ran, so the failed_retryable
    // branch always consults PG when step 2a did not.
    //
    // We model the boundary by giving the persisted row an
    // `expires_at` exactly equal to `Date.now()` (so `expiresAt < now`
    // is false at step 2a — the host-clock fast-path does NOT run).
    // The SQL-authoritative helper then runs in the failed_retryable
    // branch, and we mock it as matching 1 row (PG decided expired).
    // Result: StalePlanError in the same call, regardless of the
    // boundary timing.
    const expiresAtBoundary = new Date(Date.now());
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ expires_at: expiresAtBoundary })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const dispatcher = {
      managerDb: vi.fn(),
      managerNotify: vi.fn(),
      external: vi.fn(),
    };
    const draftReader = { readNodeDraft: vi.fn() };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher,
        draftReader,
      }),
    ).rejects.toThrow(/expired/);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(dispatcher.managerDb).not.toHaveBeenCalled();
    expect(dispatcher.managerNotify).not.toHaveBeenCalled();
    expect(dispatcher.external).not.toHaveBeenCalled();
    expect(draftReader.readNodeDraft).not.toHaveBeenCalled();
  });

  it("does not double-consult PG when step 2a's helper already confirmed in-window (avoids redundant SQL call)", async () => {
    // When step 2a fires (host clock thinks the row is past
    // expires_at) and the SQL helper returns 0 rows (PG says
    // in-window), the failed_retryable branch should fall through to
    // the idempotent return WITHOUT running the helper again. The
    // sqlExpiryConfirmedInWindow flag tracks this so we do not double-
    // consult PG on every failed_retryable confirm.
    const pastExpires = new Date(Date.now() - 30_000);
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ expires_at: pastExpires })],
      rowCount: 1,
    });
    // step 2a's helper: PG says in-window (0 rows).
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const dispatcher = {
      managerDb: vi.fn(),
      managerNotify: vi.fn(),
      external: vi.fn(),
    };
    const draftReader = { readNodeDraft: vi.fn() };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher,
      draftReader,
    });
    expect(result.status).toBe("failed_retryable");
    // Step-1 read + step-2a helper only — no second helper call from
    // the failed_retryable branch.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(dispatcher.managerDb).not.toHaveBeenCalled();
    expect(dispatcher.managerNotify).not.toHaveBeenCalled();
  });
});

describe("_internal_confirmApplyAttempt — step 3 fingerprint hint", () => {
  it("logs an advisory warning when the caller-supplied hint mismatches the persisted fingerprint, then proceeds to step 4", async () => {
    mockQuery.mockResolvedValue({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    // Short-circuit the claim: withTransaction returns null so confirm
    // exits via resolveLostClaim; the assertion is on the warn call,
    // which must fire before withTransaction is invoked.
    let observedTransactionAfterWarn = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWithTransaction.mockImplementation(async () => {
      observedTransactionAfterWarn = warn.mock.calls.length > 0;
      // tryClaim returns null → confirm enters resolveLostClaim which
      // re-reads. Have the next read return a benign succeeded row.
      mockQuery.mockResolvedValueOnce({
        rows: [persistedRow({ status: "succeeded" })],
        rowCount: 1,
      });
      return null;
    });

    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher: {
        managerDb: vi.fn(),
        managerNotify: vi.fn(),
        external: vi.fn(),
      },
      draftReader: { readNodeDraft: vi.fn() },
      // Hint that does not match the all-zeros persisted fingerprint.
      expectedDraftFingerprint: "deadbeef",
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/fingerprint hint mismatch/),
    );
    expect(observedTransactionAfterWarn).toBe(true);
    warn.mockRestore();
  });

  it("does not warn when the hint matches the persisted fingerprint", async () => {
    const fp = Buffer.alloc(32);
    const expectedHex = fp.toString("hex");
    mockQuery.mockResolvedValue({
      rows: [persistedRow({ status: "pending", draft_fingerprint: fp })],
      rowCount: 1,
    });
    mockWithTransaction.mockImplementation(async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [persistedRow({ status: "succeeded" })],
        rowCount: 1,
      });
      return null;
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher: {
        managerDb: vi.fn(),
        managerNotify: vi.fn(),
        external: vi.fn(),
      },
      draftReader: { readNodeDraft: vi.fn() },
      expectedDraftFingerprint: expectedHex,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("Atomic claim SQL — predicates", () => {
  it("retry's UPDATE WHERE pins the target dispatch to failed_retryable via jsonb_path_exists", async () => {
    // Top-level read for the lifecycle entry (step-1 read).
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow()],
      rowCount: 1,
    });

    const txQuery = vi.fn();
    // Inside tryClaim: first the SELECT (re-read inside the tx), then
    // the UPDATE we want to capture.
    txQuery.mockResolvedValueOnce({ rows: [persistedRow()], rowCount: 1 });
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockWithTransaction.mockImplementationOnce(
      async (fn: (c: unknown) => Promise<unknown>) => fn({ query: txQuery }),
    );
    // resolveLostClaim re-reads at top level after the 0-row claim.
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow()],
      rowCount: 1,
    });
    // resolveLostClaim now runs an SQL-authoritative
    // `terminaliseExpiredAttempt` (NOW() > expires_at predicate) for
    // pending / failed_retryable rows with a NULL executing_lock — so
    // a row that the host thinks is in-window but PostgreSQL has
    // already expired is still terminalised. With a future
    // expires_at this UPDATE matches 0 rows.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { _internal_retryDispatch } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    // Returns the persisted row idempotently (failed_retryable observed
    // post-loss); no throw.
    await _internal_retryDispatch({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatchId: RETRY_DISPATCH_ID,
      dispatcher: {
        managerDb: vi.fn(),
        managerNotify: vi.fn(),
        external: vi.fn(),
      },
      draftReader: { readNodeDraft: vi.fn() },
    });

    const updateCall = txQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" && sql.includes("UPDATE apply_attempts"),
    );
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/jsonb_path_exists/);
    expect(sql).toMatch(/@\.dispatchId == \$id/);
    expect(sql).toMatch(/@\.state == "failed_retryable"/);
    expect(sql).toMatch(/AND status = 'failed_retryable'/);
    // The dispatchId is bound as a SQL parameter (not interpolated).
    expect(params).toContain(RETRY_DISPATCH_ID);
  });

  it("confirm's UPDATE WHERE narrows status to 'pending' and does not include 'failed_retryable'", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });

    const txQuery = vi.fn();
    txQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockWithTransaction.mockImplementationOnce(
      async (fn: (c: unknown) => Promise<unknown>) => fn({ query: txQuery }),
    );
    // resolveLostClaim re-read returns the same pending row → busy throw.
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    // resolveLostClaim's SQL-authoritative expiry helper — future
    // expires_at on this row, so the helper matches 0.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher: {
          managerDb: vi.fn(),
          managerNotify: vi.fn(),
          external: vi.fn(),
        },
        draftReader: { readNodeDraft: vi.fn() },
      }),
    ).rejects.toThrow();

    const updateCall = txQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" && sql.includes("UPDATE apply_attempts"),
    );
    expect(updateCall).toBeDefined();
    const [sql] = updateCall as [string];
    expect(sql).toMatch(/AND status = 'pending'/);
    expect(sql).not.toMatch(/IN \('pending', 'failed_retryable'\)/);
  });
});

describe("resolveLostClaim — SQL-authoritative expiry", () => {
  it("converts a lost claim to StalePlanError when the SQL helper says the row was past expires_at, even with future expires_at on the host clock", async () => {
    // Models the clock-skew case the umbrella requires us to handle:
    // step-4's `NOW() <= expires_at` rejected the claim because the
    // DB clock crossed expires_at — but the host clock has not yet,
    // so the app-row snapshot still shows a future deadline. The
    // SQL-authoritative `terminaliseExpiredAttempt` is what decides:
    // when its UPDATE matches >0 rows, resolveLostClaim must surface
    // StalePlanError (not ApplyAttemptBusyError, not an idempotent
    // failed_retryable return).
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    const txQuery = vi.fn();
    txQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockWithTransaction.mockImplementationOnce(
      async (fn: (c: unknown) => Promise<unknown>) => fn({ query: txQuery }),
    );
    // resolveLostClaim re-read.
    mockQuery.mockResolvedValueOnce({
      rows: [persistedRow({ status: "pending" })],
      rowCount: 1,
    });
    // SQL-authoritative terminaliseExpiredAttempt: DB says expired → 1 row.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher: {
          managerDb: vi.fn(),
          managerNotify: vi.fn(),
          external: vi.fn(),
        },
        draftReader: { readNodeDraft: vi.fn() },
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe("writeStaleAndClear — loser-write rejection", () => {
  it("throws ApplyAttemptBusyError when the guarded UPDATE matches 0 rows (recovery cleared the lock between 5b and 5c)", async () => {
    // The full path: confirm → claim → manager dispatch → 5b drift
    // detected → writeStaleAndClear UPDATE matches 0 rows because
    // the recovery sweep cleared executing_lock first. Per the
    // umbrella's loser-write rule the executor must abort with the
    // lost-claim signal — it must NOT report a successful `stale`
    // outcome over what recovery wrote.
    const fp = Buffer.alloc(32);
    // Top-level read: pending + matching fingerprint, future TTL.
    mockQuery.mockResolvedValueOnce({
      rows: [
        persistedRow({
          status: "pending",
          draft_fingerprint: fp,
          planned_dispatches: [
            {
              dispatchId: "dd111111-1111-1111-1111-111111111111",
              kind: "MANAGER_DB",
              state: "queued",
              attemptCount: 0,
              lastError: null,
            },
          ],
        }),
      ],
      rowCount: 1,
    });

    const txQueries: Array<{ rows: unknown[]; rowCount: number }> = [];
    const txQuery = vi.fn(
      async () => txQueries.shift() ?? { rows: [], rowCount: 0 },
    );

    let txCallIdx = 0;
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => {
        txCallIdx += 1;
        if (txCallIdx === 1) {
          // tryClaim transaction: SELECT + UPDATE (success) + final SELECT.
          txQueries.push({
            rows: [
              persistedRow({
                status: "pending",
                draft_fingerprint: fp,
                planned_dispatches: [
                  {
                    dispatchId: "dd111111-1111-1111-1111-111111111111",
                    kind: "MANAGER_DB",
                    state: "queued",
                    attemptCount: 0,
                    lastError: null,
                  },
                ],
              }),
            ],
            rowCount: 1,
          });
          txQueries.push({ rows: [], rowCount: 1 });
          txQueries.push({
            rows: [
              persistedRow({
                status: "executing",
                draft_fingerprint: fp,
                executing_lock: "lock-1",
                planned_dispatches: [
                  {
                    dispatchId: "dd111111-1111-1111-1111-111111111111",
                    kind: "MANAGER_DB",
                    state: "in_flight",
                    attemptCount: 1,
                    lastError: null,
                  },
                ],
              }),
            ],
            rowCount: 1,
          });
        } else if (txCallIdx === 2) {
          // writeStaleAndClear transaction: 0 rows (recovery cleared lock).
          txQueries.push({ rows: [], rowCount: 0 });
        }
        return fn({ query: txQuery });
      },
    );

    const drifted = {
      id: "node-1",
      name: "drifted",
      nameDraft: null,
      profile: null,
      profileDraft: null,
      agents: [],
      externalServices: [],
    };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const dispatcher = {
      managerDb: vi.fn(),
      managerNotify: vi.fn(),
      external: vi.fn(),
    };
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher,
        draftReader: {
          async readNodeDraft() {
            return drifted;
          },
        },
      }),
    ).rejects.toThrow(/lost its claim/);
    // Manager dispatcher never invoked — drift caught at 5b before 5d.
    expect(dispatcher.managerDb).not.toHaveBeenCalled();
    expect(dispatcher.managerNotify).not.toHaveBeenCalled();
  });
});

describe("runExecutor — post-DB fan-out (#550, parallel-after-DB)", () => {
  // Build a Node snapshot whose computed fingerprint we can pin into
  // the persisted row so step 5b matches and the executor proceeds
  // through MANAGER_DB → post-DB fan-out. These tests use a minimal
  // empty Node so the fingerprint is stable across them.
  const NODE_SNAPSHOT = {
    id: "node-1",
    name: "n",
    nameDraft: null,
    profile: null,
    profileDraft: null,
    agents: [],
    externalServices: [],
  };
  const MANAGER_DB_DISPATCH_ID = "d0000001-0000-0000-0000-000000000001";
  const MANAGER_NOTIFY_DISPATCH_ID = "d0000002-0000-0000-0000-000000000002";
  const DATA_STORE_DISPATCH_ID = "d0000003-0000-0000-0000-000000000003";
  const TI_CONTAINER_DISPATCH_ID = "d0000004-0000-0000-0000-000000000004";

  /**
   * Stateful in-memory mock of `apply_attempts`. Routes top-level
   * `query` calls and `withTransaction(client.query)` calls to the
   * same logical row, so the post-DB fan-out's parallel
   * commitOneDispatchResult / finaliseRowFromPostDb path can read
   * back its own writes in any order.
   *
   * Recognised SQL patterns:
   *   - `SELECT … FROM apply_attempts WHERE attempt_id = $1`
   *   - tryClaim's `UPDATE … SET status='executing', executing_lock=$1, …`
   *   - fan-out's `UPDATE … SET executing_lock = NULL, claim_started_at = NULL, planned_dispatches = $2 …`
   *     (the post-DB handoff)
   *   - commitOneDispatchResult's `UPDATE … jsonb_path_exists … @.dispatchId == $id && @.lockToken == $tok`
   *   - finaliseRowFromPostDb's `UPDATE … SET status = 'failed_retryable' …` or
   *     `UPDATE … SET status = $2, expires_at = …`
   *   - terminal/finalising paths from the DB-failure branch and
   *     writeStaleAndClear (returned as no-ops here — these tests
   *     never reach those branches).
   */
  function makeStatefulRow(initial: Record<string, unknown>): {
    state: () => Record<string, unknown>;
    query: (
      sql: string,
      params?: unknown[],
    ) => {
      rows: Record<string, unknown>[];
      rowCount: number;
    };
  } {
    let row: Record<string, unknown> = { ...initial };
    function planned(): Record<string, unknown>[] {
      return row.planned_dispatches as Record<string, unknown>[];
    }
    return {
      state: () => row,
      query: (sql, params = []) => {
        if (/^\s*SELECT[\s\S]+FROM apply_attempts/i.test(sql)) {
          return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/UPDATE apply_attempts\s+SET status = 'executing'/i.test(sql)) {
          // tryClaim
          row = {
            ...row,
            status: "executing",
            executing_lock: params[0] as string,
            claim_started_at: new Date(),
            planned_dispatches: JSON.parse(params[1] as string),
          };
          return { rows: [{ attempt_id: row.attempt_id }], rowCount: 1 };
        }
        if (
          /UPDATE apply_attempts\s+SET executing_lock = NULL,\s+claim_started_at = NULL,\s+planned_dispatches = \$2::jsonb\s+WHERE attempt_id = \$1\s+AND executing_lock = \$3/i.test(
            sql,
          )
        ) {
          // commitDbSuccessAndFanOut (no row-status change)
          row = {
            ...row,
            executing_lock: null,
            claim_started_at: null,
            planned_dispatches: JSON.parse(params[1] as string),
          };
          return { rows: [{ attempt_id: row.attempt_id }], rowCount: 1 };
        }
        if (/jsonb_path_exists\([\s\S]+@\.lockToken == \$tok/i.test(sql)) {
          // commitOneDispatchResult — match by dispatchId + lockToken
          const dispatchId = params[1] as string;
          const lockToken = params[2] as string;
          const newState = params[3] as string;
          const lastError = (params[4] as string | null) ?? null;
          const updated = planned().map((d) => {
            const cur = d as Record<string, unknown>;
            if (cur.dispatchId === dispatchId && cur.lockToken === lockToken) {
              const { lockToken: _t, claimStartedAt: _c, ...rest } = cur;
              return { ...rest, state: newState, lastError };
            }
            return d;
          });
          const changed = updated.some(
            (d, i) => JSON.stringify(d) !== JSON.stringify(planned()[i]),
          );
          if (!changed) return { rows: [], rowCount: 0 };
          row = { ...row, planned_dispatches: updated };
          return { rows: [{ attempt_id: row.attempt_id }], rowCount: 1 };
        }
        if (
          /UPDATE apply_attempts\s+SET status = 'failed_retryable',\s+planned_dispatches = \$2::jsonb\s+WHERE attempt_id = \$1\s+AND status = 'executing'\s+AND executing_lock IS NULL/i.test(
            sql,
          )
        ) {
          // finaliseRowFromPostDb — failed_retryable branch
          if (row.status !== "executing" || row.executing_lock !== null)
            return { rows: [], rowCount: 0 };
          row = {
            ...row,
            status: "failed_retryable",
            planned_dispatches: JSON.parse(params[1] as string),
          };
          return { rows: [{ attempt_id: row.attempt_id }], rowCount: 1 };
        }
        if (
          /UPDATE apply_attempts\s+SET status = \$2,\s+expires_at = NOW\(\) \+ \(\$3 \|\| ' milliseconds'\)::interval,\s+planned_dispatches = \$4::jsonb\s+WHERE attempt_id = \$1\s+AND status = 'executing'\s+AND executing_lock IS NULL/i.test(
            sql,
          )
        ) {
          // finaliseRowFromPostDb — terminal branch
          if (row.status !== "executing" || row.executing_lock !== null)
            return { rows: [], rowCount: 0 };
          row = {
            ...row,
            status: params[1] as string,
            expires_at: new Date(Date.now() + 60_000),
            planned_dispatches: JSON.parse(params[3] as string),
          };
          return { rows: [{ attempt_id: row.attempt_id }], rowCount: 1 };
        }
        // Unknown SQL — surface as 0 rows so the executor can route
        // through its lost-claim path if it expected a write.
        return { rows: [], rowCount: 0 };
      },
    };
  }

  async function planThreeDispatches() {
    const { computeDraftFingerprint } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const fp = computeDraftFingerprint(NODE_SNAPSHOT).bytes;
    return {
      fp,
      plan: [
        {
          dispatchId: MANAGER_DB_DISPATCH_ID,
          kind: "MANAGER_DB",
          state: "queued",
          attemptCount: 0,
          lastError: null,
        },
        {
          dispatchId: MANAGER_NOTIFY_DISPATCH_ID,
          kind: "MANAGER_NOTIFY",
          state: "queued",
          attemptCount: 0,
          lastError: null,
        },
        {
          dispatchId: DATA_STORE_DISPATCH_ID,
          kind: "DATA_STORE",
          state: "queued",
          attemptCount: 0,
          lastError: null,
          new: "{ds}",
        },
      ] as const,
    };
  }

  it("retryable notify failure runs in parallel with external dispatch and does not block it — row settles failed_retryable", async () => {
    const { fp, plan } = await planThreeDispatches();
    const stateful = makeStatefulRow(
      persistedRow({
        status: "pending",
        draft_fingerprint: fp,
        planned_dispatches: plan,
      }),
    );

    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
      stateful.query(sql, params),
    );
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => {
        return fn({
          query: async (sql: string, params?: unknown[]) =>
            stateful.query(sql, params),
        });
      },
    );

    const dispatcher = {
      managerDb: vi.fn().mockResolvedValue(undefined),
      managerNotify: vi.fn().mockRejectedValue(new Error("notify boom")),
      external: vi.fn().mockResolvedValue(undefined),
    };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher,
      draftReader: {
        async readNodeDraft() {
          return NODE_SNAPSHOT;
        },
      },
    });

    expect(dispatcher.managerDb).toHaveBeenCalledTimes(1);
    expect(dispatcher.managerNotify).toHaveBeenCalledTimes(1);
    expect(dispatcher.external).toHaveBeenCalledTimes(1);

    expect(result.status).toBe("failed_retryable");
    expect(result.plannedDispatches[0].state).toBe("succeeded");
    expect(result.plannedDispatches[1].state).toBe("failed_retryable");
    expect(result.plannedDispatches[2].state).toBe("succeeded");
    // Per-dispatch claim markers are stripped on finalisation — they
    // must not leak into the persisted row's terminal state.
    for (const d of result.plannedDispatches) {
      expect((d as { lockToken?: string }).lockToken).toBeUndefined();
      expect((d as { claimStartedAt?: string }).claimStartedAt).toBeUndefined();
    }
  });

  it("terminal notify failure (e.g. hostname-empty) does not cascade unrelated externals — externals still run in parallel and keep their observed state", async () => {
    const { fp, plan } = await planThreeDispatches();
    // Two-external plan to exercise per-dispatch state isolation
    // across multiple unrelated externals.
    const planWithTwoExternals = [
      plan[0],
      plan[1],
      plan[2],
      {
        dispatchId: TI_CONTAINER_DISPATCH_ID,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{ti}",
      },
    ];

    const stateful = makeStatefulRow(
      persistedRow({
        status: "pending",
        draft_fingerprint: fp,
        planned_dispatches: planWithTwoExternals,
      }),
    );

    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
      stateful.query(sql, params),
    );
    mockWithTransaction.mockImplementation(
      async (fn: (c: unknown) => Promise<unknown>) => {
        return fn({
          query: async (sql: string, params?: unknown[]) =>
            stateful.query(sql, params),
        });
      },
    );

    const { DispatchTerminalFailureError } = await import("@/lib/node/errors");
    const dispatcher = {
      managerDb: vi.fn().mockResolvedValue(undefined),
      managerNotify: vi
        .fn()
        .mockRejectedValue(new DispatchTerminalFailureError("hostname empty")),
      external: vi.fn().mockResolvedValue(undefined),
    };
    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatcher,
      draftReader: {
        async readNodeDraft() {
          return NODE_SNAPSHOT;
        },
      },
    });

    expect(dispatcher.managerDb).toHaveBeenCalledTimes(1);
    expect(dispatcher.managerNotify).toHaveBeenCalledTimes(1);
    expect(dispatcher.external).toHaveBeenCalledTimes(2);

    expect(result.status).toBe("failed_terminal");
    expect(result.plannedDispatches[0].state).toBe("succeeded");
    expect(result.plannedDispatches[1].state).toBe("failed_terminal");
    expect(result.plannedDispatches[1].lastError).toBe("hostname empty");
    expect(result.plannedDispatches[2].state).toBe("succeeded");
    expect(result.plannedDispatches[3].state).toBe("succeeded");
    // Externals carry their own (success) lastError, not notify's
    // terminal error.
    expect(result.plannedDispatches[2].lastError).toBe(null);
    expect(result.plannedDispatches[3].lastError).toBe(null);
  });
});
