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
        kind: "MANAGER",
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
  it("returns the persisted row unchanged when status is failed_retryable; no claim attempted; no dispatcher call", async () => {
    mockQuery.mockResolvedValue({ rows: [persistedRow()], rowCount: 1 });
    const dispatcher = {
      manager: vi.fn(),
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
    // Only the step-1 read; no executor / no claim transaction.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(dispatcher.manager).not.toHaveBeenCalled();
    expect(dispatcher.external).not.toHaveBeenCalled();
    expect(draftReader.readNodeDraft).not.toHaveBeenCalled();
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
      dispatcher: { manager: vi.fn(), external: vi.fn() },
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
      dispatcher: { manager: vi.fn(), external: vi.fn() },
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

    const { _internal_retryDispatch } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    // Returns the persisted row idempotently (failed_retryable observed
    // post-loss); no throw.
    await _internal_retryDispatch({
      session: makeSession(),
      attemptId: ATTEMPT_ID,
      dispatchId: RETRY_DISPATCH_ID,
      dispatcher: { manager: vi.fn(), external: vi.fn() },
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

    const { _internal_confirmApplyAttempt } = await import(
      "@/lib/node/apply-attempt-lifecycle"
    );
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId: ATTEMPT_ID,
        dispatcher: { manager: vi.fn(), external: vi.fn() },
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
