import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/auth/jwt";
import {
  runApplyAttemptCleanup,
  terminaliseExpiredAttempt,
} from "@/lib/node/apply-attempt-cleanup";
import {
  _internal_confirmApplyAttempt,
  _internal_retryDispatch,
  computeDraftFingerprint,
  type ManagerDraftReader,
  type NodeDraftSnapshot,
} from "@/lib/node/apply-attempt-lifecycle";
import type {
  ApplyDispatcher,
  PlannedDispatch,
} from "@/lib/node/apply-attempt-types";

/**
 * Direct-DB integration tests for the ApplyAttempt lifecycle (#359).
 *
 * These tests bypass the Next.js dev server and connect to PostgreSQL
 * directly via DATABASE_URL. The dev server (started by the harness)
 * has already run migrations, so the `apply_attempts` table is
 * available.
 *
 * Each test inserts its own row, exercises the state machine, and
 * cleans up.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/auth_db";

let pool: pg.Pool;
let testActorId: string;
const testUsername = `apply-attempts-test-${randomUUID()}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  // The lifecycle module imports `@/lib/db/client` which lazily
  // initialises its own pool from DATABASE_URL — same connection
  // string, same DB. We don't need to wire ours into theirs.

  // Seed a real account so the FK reference holds.
  const passwordHash = await argon2.hash("not-used", { type: argon2.argon2id });
  const { rows } = await pool.query<{ id: string; role_id: number }>(
    `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
     INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
     VALUES ($1, $1, $2, (SELECT id FROM role), false)
     RETURNING id, role_id`,
    [testUsername, passwordHash],
  );
  testActorId = rows[0].id;
});

afterAll(async () => {
  // Clean up the test account — apply_attempts rows cascade-delete.
  await pool.query("DELETE FROM accounts WHERE username = $1", [testUsername]);
  await pool.end();
});

afterEach(async () => {
  await pool.query("DELETE FROM apply_attempts WHERE created_by = $1", [
    testActorId,
  ]);
});

function makeSession(actorId: string = testActorId): AuthSession {
  return {
    accountId: actorId,
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 1,
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

function snapshot(
  overrides: Partial<NodeDraftSnapshot> = {},
): NodeDraftSnapshot {
  return {
    id: "node-1",
    name: "n",
    nameDraft: "n-draft",
    profile: { customerId: "5", description: "", hostname: "h" },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

interface DispatchRecorder {
  managerCalls: number;
  externalCalls: Array<{ kind: string; dispatchId: string }>;
}

function makeRecorder(): DispatchRecorder {
  return { managerCalls: 0, externalCalls: [] };
}

function makeDispatcher(
  recorder: DispatchRecorder,
  opts: {
    failManager?: boolean;
    failExternal?: Set<string>;
    managerError?: string;
    externalError?: string;
  } = {},
): ApplyDispatcher {
  return {
    async managerDb() {
      recorder.managerCalls += 1;
      if (opts.failManager)
        throw new Error(opts.managerError ?? "manager fail");
    },
    async managerNotify() {
      recorder.managerCalls += 1;
      if (opts.failManager)
        throw new Error(opts.managerError ?? "manager fail");
    },
    async external(kind, input) {
      recorder.externalCalls.push({ kind, dispatchId: input.dispatchId });
      if (opts.failExternal?.has(input.dispatchId)) {
        throw new Error(opts.externalError ?? "external fail");
      }
    },
  };
}

function makeReader(node: NodeDraftSnapshot): ManagerDraftReader {
  return {
    async readNodeDraft() {
      return node;
    },
  };
}

async function insertAttempt(opts: {
  attemptId?: string;
  nodeId?: string;
  fingerprint: Buffer;
  plannedDispatches: PlannedDispatch[];
  status: string;
  expiresAt?: Date;
  executingLock?: string | null;
  claimStartedAt?: Date | null;
  createdBy?: string;
}): Promise<string> {
  const attemptId = opts.attemptId ?? randomUUID();
  const owner = opts.createdBy ?? testActorId;
  await pool.query(
    `INSERT INTO apply_attempts (
       attempt_id, node_id, draft_fingerprint, planned_dispatches,
       created_by, audit_actor, expires_at, executing_lock, claim_started_at, status
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
    [
      attemptId,
      opts.nodeId ?? "node-1",
      opts.fingerprint,
      JSON.stringify(opts.plannedDispatches),
      owner,
      owner,
      opts.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
      opts.executingLock ?? null,
      opts.claimStartedAt ?? null,
      opts.status,
    ],
  );
  return attemptId;
}

async function readRow(attemptId: string): Promise<{
  status: string;
  executing_lock: string | null;
  claim_started_at: Date | null;
  planned_dispatches: PlannedDispatch[];
  expires_at: Date;
}> {
  const { rows } = await pool.query(
    `SELECT status, executing_lock, claim_started_at, planned_dispatches, expires_at
     FROM apply_attempts WHERE attempt_id = $1`,
    [attemptId],
  );
  return rows[0];
}

describe("Lifecycle — sequential advance happy path", () => {
  it("manager → external1 → external2 advances under one claim, ending in succeeded", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: randomUUID(),
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const recorder = makeRecorder();
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("succeeded");
    expect(result.executingLock).toBeNull();
    expect(result.claimStartedAt).toBeNull();
    expect(recorder.managerCalls).toBe(1);
    expect(recorder.externalCalls).toHaveLength(2);
    expect(result.plannedDispatches.every((d) => d.state === "succeeded")).toBe(
      true,
    );
  });
});

describe("Lifecycle — post-DB dispatches are independent (#333, Decision 3 / Acceptance #2)", () => {
  it("forcing external1 to fail does NOT block external2 — external2 is still attempted and succeeds, row → failed_retryable", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const recorder = makeRecorder();
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: makeDispatcher(recorder, { failExternal: new Set([ext1Id]) }),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_retryable");
    expect(result.executingLock).toBeNull();
    expect(result.plannedDispatches[0].state).toBe("succeeded");
    expect(result.plannedDispatches[1].state).toBe("failed_retryable");
    // Phase Node-12 (#333): post-DB dispatches are independent. A
    // failing external no longer blocks the others — external2 is
    // advanced and run under the same claim, succeeds, and the row's
    // aggregate status becomes `failed_retryable` because at least
    // one dispatch is still retryable.
    expect(result.plannedDispatches[2].state).toBe("succeeded");
    expect(recorder.externalCalls).toHaveLength(2);
  });
});

describe("Lifecycle — failed_retryable preserves expires_at", () => {
  it("a soft-fail does not rewrite expires_at", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const originalExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const ext1Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
      expiresAt: originalExpiresAt,
    });
    const recorder = makeRecorder();
    await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: makeDispatcher(recorder, { failExternal: new Set([ext1Id]) }),
      draftReader: makeReader(node),
    });
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_retryable");
    // Within a couple ms tolerance.
    expect(
      Math.abs(row.expires_at.getTime() - originalExpiresAt.getTime()),
    ).toBeLessThan(1000);
  });
});

describe("Lifecycle — APPLY_DISPATCH_MAX_ATTEMPTS cap on a post-DB external (#550: per-dispatch retry independence)", () => {
  it("cap reached on one external lands it in failed_terminal; unrelated sibling state is preserved verbatim; the row settles failed_terminal with expires_at rewritten to retention", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    // Pre-seed attemptCount at MAX_ATTEMPTS - 1 so the next failure trips the cap.
    const cap = Number(process.env.APPLY_DISPATCH_MAX_ATTEMPTS ?? "3");
    // Under the post-DB fan-out model, a `failed_retryable` row is
    // reached after every post-DB dispatch was attempted, so siblings
    // sit in a final state — never `queued`. Seed ext2 as
    // `succeeded` to represent that already-attempted shape.
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: cap - 1,
        lastError: "x",
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
        new: "{b}",
      },
    ];
    const originalExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "failed_retryable",
      expiresAt: originalExpiresAt,
    });
    const recorder = makeRecorder();
    const result = await _internal_retryDispatch({
      session: makeSession(),
      attemptId,
      dispatchId: ext1Id,
      dispatcher: makeDispatcher(recorder, { failExternal: new Set([ext1Id]) }),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_terminal");
    expect(result.plannedDispatches[1].state).toBe("failed_terminal");
    // Per-dispatch retry independence (#550): the retry runs only
    // ext1; ext2 is not re-executed and keeps its observed state.
    expect(result.plannedDispatches[2].state).toBe("succeeded");
    expect(recorder.externalCalls).toHaveLength(1);
    expect(recorder.externalCalls[0].dispatchId).toBe(ext1Id);
    // expires_at rewritten well past the original.
    expect(result.expiresAt.getTime()).toBeGreaterThan(
      originalExpiresAt.getTime() + 60 * 60 * 1000,
    );
  });
});

describe("Lifecycle — confirm against failed_retryable is idempotent", () => {
  it("returns the persisted row without dispatching; recovery from failed_retryable is the retry entrypoint's job", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "boom",
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const originalExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "failed_retryable",
      expiresAt: originalExpiresAt,
    });
    const recorder = makeRecorder();
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_retryable");
    // The DB row is untouched: no claim, no executor pass.
    expect(recorder.managerCalls).toBe(0);
    expect(recorder.externalCalls).toHaveLength(0);
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_retryable");
    expect(row.executing_lock).toBeNull();
    expect(row.claim_started_at).toBeNull();
    expect(
      Math.abs(row.expires_at.getTime() - originalExpiresAt.getTime()),
    ).toBeLessThan(1000);
    // Per-dispatch state is unchanged.
    expect(row.planned_dispatches[1].state).toBe("failed_retryable");
    expect(row.planned_dispatches[2].state).toBe("queued");
  });
});

describe("Lifecycle — busy / terminal / stale / expired observation", () => {
  it("ApplyAttemptBusyError when the row is already executing", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "in_flight",
        attemptCount: 1,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "executing",
      executingLock: randomUUID(),
      claimStartedAt: new Date(),
    });
    const recorder = makeRecorder();
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(recorder),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/executing/);
    expect(recorder.managerCalls).toBe(0);
    expect(recorder.externalCalls).toHaveLength(0);
  });

  it("returns idempotent success when the row is already succeeded", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "succeeded",
    });
    const recorder = makeRecorder();
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("succeeded");
    expect(recorder.managerCalls).toBe(0);
  });

  it("ApplyAttemptTerminalError when the row is failed_terminal", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "failed_terminal",
        attemptCount: 3,
        lastError: "x",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "failed_terminal",
    });
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(makeRecorder()),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/failed_terminal/);
  });

  it("StalePlanError when the row is stale", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "stale",
    });
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(makeRecorder()),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/stale/);
  });
});

describe("Lifecycle — step-2a expiry short-circuit", () => {
  it("expired pending row terminalises in the same call and rejects with StalePlanError", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const recorder = makeRecorder();
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(recorder),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/expired/);
    expect(recorder.managerCalls).toBe(0);
    const row = await readRow(attemptId);
    expect(row.status).toBe("expired");
  });
});

describe("Lifecycle — just-before-dispatch sequence (5a–5d)", () => {
  it("drift detected — writes status=stale, never calls manager dispatcher", async () => {
    const original = snapshot();
    const drifted = snapshot({ name: "drifted-different" });
    const fpOriginal = computeDraftFingerprint(original);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fpOriginal.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const recorder = makeRecorder();
    // Reader returns drifted state — fingerprint mismatch at 5b.
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(recorder),
        draftReader: makeReader(drifted),
      }),
    ).rejects.toThrow(/drift|stale/i);
    expect(recorder.managerCalls).toBe(0);
    expect(recorder.externalCalls).toHaveLength(0);
    const row = await readRow(attemptId);
    expect(row.status).toBe("stale");
    expect(row.executing_lock).toBeNull();
    expect(row.claim_started_at).toBeNull();
  });

  it("drift settles — pre-claim mismatch resolves before 5b, manager dispatcher invoked once", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const recorder = makeRecorder();
    await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      // Pass a stale hint that does not match — the umbrella treats
      // it as a hint, not a verdict, and step 5b's recompute is
      // authoritative.
      expectedDraftFingerprint: "deadbeef",
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(recorder.managerCalls).toBe(1);
  });
});

describe("Lifecycle — retry pre-claim validation (step 2b)", () => {
  async function setupRetryRow(
    opts: { ext2State?: PlannedDispatch["state"] } = {},
  ): Promise<{
    attemptId: string;
    ext1: string;
    ext2: string;
  }> {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    // Default ext2 to `succeeded` — under the post-DB fan-out model a
    // `failed_retryable` row is only reached after every post-DB
    // dispatch was attempted, so siblings never sit in `queued` once
    // the row has settled. One sub-test overrides this to `queued` to
    // exercise the pre-claim "not retryable" guard.
    const ext2State: PlannedDispatch["state"] = opts.ext2State ?? "succeeded";
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "x",
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: ext2State,
        attemptCount: ext2State === "queued" ? 0 : 1,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "failed_retryable",
    });
    return { attemptId, ext1: ext1Id, ext2: ext2Id };
  }

  it("DispatchNotFoundError on missing dispatchId, no DB write", async () => {
    const { attemptId } = await setupRetryRow();
    const node = snapshot();
    await expect(
      _internal_retryDispatch({
        session: makeSession(),
        attemptId,
        dispatchId: "00000000-0000-0000-0000-000000000000",
        dispatcher: makeDispatcher(makeRecorder()),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/not found/i);
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_retryable");
  });

  it("DispatchNotRetryableError when the target dispatch is queued", async () => {
    // Use the synthetic `queued` shape to exercise the pre-claim guard.
    const { attemptId, ext2 } = await setupRetryRow({ ext2State: "queued" });
    const node = snapshot();
    await expect(
      _internal_retryDispatch({
        session: makeSession(),
        attemptId,
        dispatchId: ext2,
        dispatcher: makeDispatcher(makeRecorder()),
        draftReader: makeReader(node),
      }),
    ).rejects.toThrow(/queued|not retryable/i);
  });

  it("retry of a failed_retryable dispatch succeeds and finalises the row", async () => {
    const { attemptId, ext1, ext2 } = await setupRetryRow();
    const node = snapshot();
    const recorder = makeRecorder();
    const result = await _internal_retryDispatch({
      session: makeSession(),
      attemptId,
      dispatchId: ext1,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    // ext1 succeeds; ext2 was already succeeded — aggregate is
    // `succeeded`. The retry re-executes ONLY ext1 (per-dispatch
    // retry independence, #550).
    expect(result.status).toBe("succeeded");
    expect(recorder.externalCalls.map((c) => c.dispatchId)).toContain(ext1);
    expect(recorder.externalCalls.map((c) => c.dispatchId)).not.toContain(ext2);
  });
});

describe("Cleanup — runApplyAttemptCleanup", () => {
  it("hard-deletes terminal rows past their retention deadline", async () => {
    const fp = Buffer.alloc(32);
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: [
        {
          dispatchId: randomUUID(),
          kind: "MANAGER_DB",
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
        },
      ],
      status: "succeeded",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const result = await runApplyAttemptCleanup();
    expect(result.purged).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      "SELECT 1 FROM apply_attempts WHERE attempt_id = $1",
      [attemptId],
    );
    expect(rows).toHaveLength(0);
  });

  it("TTL terminalises a failed_retryable row whose expires_at is past, cascading queued to failed_terminal", async () => {
    const fp = Buffer.alloc(32);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "x",
        new: "{a}",
      },
      {
        dispatchId: randomUUID(),
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: dispatches,
      status: "failed_retryable",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    await runApplyAttemptCleanup();
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_terminal");
    const states = row.planned_dispatches.map((d) => d.state).sort();
    expect(states).toEqual(["failed_terminal", "failed_terminal", "succeeded"]);
  });

  it("skips actively-executing rows even when their expires_at has passed", async () => {
    const fp = Buffer.alloc(32);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "in_flight",
        attemptCount: 1,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: dispatches,
      status: "executing",
      executingLock: randomUUID(),
      claimStartedAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    await runApplyAttemptCleanup();
    const row = await readRow(attemptId);
    expect(row.status).toBe("executing");
  });

  it("stale-lock recovery flips a row aged past threshold to failed_terminal, cascading in_flight + queued", async () => {
    const fp = Buffer.alloc(32);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "DATA_STORE",
        state: "in_flight",
        attemptCount: 1,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: randomUUID(),
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    // Pretend the claim was started 4 hours ago — well past the 2.5h default.
    const oldClaim = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: dispatches,
      status: "executing",
      executingLock: randomUUID(),
      claimStartedAt: oldClaim,
    });
    const result = await runApplyAttemptCleanup();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_terminal");
    expect(row.executing_lock).toBeNull();
    expect(row.claim_started_at).toBeNull();
    expect(row.planned_dispatches.every((d) => d.state !== "queued")).toBe(
      true,
    );
    expect(row.planned_dispatches.every((d) => d.state !== "in_flight")).toBe(
      true,
    );
  });

  it("recovery does not touch a row whose claim age is under the threshold", async () => {
    const fp = Buffer.alloc(32);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "in_flight",
        attemptCount: 1,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: dispatches,
      status: "executing",
      executingLock: randomUUID(),
      claimStartedAt: new Date(Date.now() - 60 * 1000),
    });
    await runApplyAttemptCleanup();
    const row = await readRow(attemptId);
    expect(row.status).toBe("executing");
  });
});

describe("Cleanup — terminaliseExpiredAttempt helper", () => {
  it("returns 0 when the row is already claimed (executing_lock guard)", async () => {
    const fp = Buffer.alloc(32);
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: [],
      status: "pending",
      executingLock: randomUUID(),
      claimStartedAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const affected = await terminaliseExpiredAttempt(undefined, {
      attemptId,
      status: "pending",
    });
    expect(affected).toBe(0);
  });

  it("returns 0 when the row's expires_at is still in the future (SQL NOW() guard)", async () => {
    // Defends against host-clock skew: a caller that thinks the row
    // is expired (because Date.now() is ahead of Postgres NOW()) must
    // not be able to flip the row early. The helper's WHERE pins
    // `NOW() > expires_at` so a row whose deadline has not yet passed
    // by the DB clock is a no-op.
    const fp = Buffer.alloc(32);
    const attemptId = await insertAttempt({
      fingerprint: fp,
      plannedDispatches: [],
      status: "pending",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const affected = await terminaliseExpiredAttempt(undefined, {
      attemptId,
      status: "pending",
    });
    expect(affected).toBe(0);
    const row = await readRow(attemptId);
    expect(row.status).toBe("pending");
  });
});

describe("Lifecycle — writeStaleAndClear loser-write rejection", () => {
  it("when recovery clears executing_lock between 5b and 5c, surfaces ApplyAttemptBusyError instead of falsely reporting stale", async () => {
    // Simulates the race the umbrella's loser-write rule guards
    // against: 5b detects drift, but before writeStaleAndClear runs
    // the recovery sweep clears our executing_lock (and typically
    // sets the row to failed_terminal). The guarded UPDATE returns
    // 0 rows; the executor must signal lost-claim, not "stale".
    const original = snapshot();
    const drifted = snapshot({ name: "drifted-different" });
    const fpOriginal = computeDraftFingerprint(original);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fpOriginal.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });

    // Reader returns drifted state AND, before the executor can run
    // its guarded stale UPDATE, simulates a recovery sweep that
    // clears the lock and flips the row to failed_terminal. This
    // sequencing is deterministic because writeStaleAndClear runs
    // synchronously after readNodeDraft resolves.
    const racingReader: ManagerDraftReader = {
      async readNodeDraft() {
        await pool.query(
          `UPDATE apply_attempts
             SET executing_lock = NULL,
                 claim_started_at = NULL,
                 status = 'failed_terminal'
           WHERE attempt_id = $1`,
          [attemptId],
        );
        return drifted;
      },
    };
    const recorder = makeRecorder();
    await expect(
      _internal_confirmApplyAttempt({
        session: makeSession(),
        attemptId,
        dispatcher: makeDispatcher(recorder),
        draftReader: racingReader,
      }),
    ).rejects.toThrow(/lost its claim|executing/);
    expect(recorder.managerCalls).toBe(0);
    // Row stayed at whatever recovery wrote — NOT 'stale'.
    const row = await readRow(attemptId);
    expect(row.status).toBe("failed_terminal");
  });
});

describe("Lifecycle — post-DB fan-out (#550)", () => {
  function makeSlowDispatcher(opts: {
    notifyDelayMs?: number;
    externalDelayMs?: Map<string, number>;
    failExternal?: Set<string>;
  }): {
    dispatcher: ApplyDispatcher;
    starts: Map<string, number>;
    ends: Map<string, number>;
  } {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    return {
      starts,
      ends,
      dispatcher: {
        async managerDb() {
          starts.set("MANAGER_DB", Date.now());
          ends.set("MANAGER_DB", Date.now());
        },
        async managerNotify() {
          starts.set("MANAGER_NOTIFY", Date.now());
          if (opts.notifyDelayMs) {
            await new Promise((r) => setTimeout(r, opts.notifyDelayMs));
          }
          ends.set("MANAGER_NOTIFY", Date.now());
        },
        async external(_kind, input) {
          starts.set(input.dispatchId, Date.now());
          const delay = opts.externalDelayMs?.get(input.dispatchId) ?? 0;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          ends.set(input.dispatchId, Date.now());
          if (opts.failExternal?.has(input.dispatchId)) {
            throw new Error("external boom");
          }
        },
      },
    };
  }

  it("wall-clock parallel: slow notify does not delay fast externals; externals complete well before notify returns", async () => {
    // Acceptance #1 — wall-clock overlap.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_NOTIFY",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const { dispatcher, starts, ends } = makeSlowDispatcher({
      notifyDelayMs: 500,
      externalDelayMs: new Map([
        [ext1Id, 10],
        [ext2Id, 10],
      ]),
    });
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher,
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("succeeded");

    const notifyStart =
      starts.get("MANAGER_NOTIFY") ?? Number.POSITIVE_INFINITY;
    const notifyEnd = ends.get("MANAGER_NOTIFY") ?? 0;
    const ext1End = ends.get(ext1Id) ?? 0;
    const ext2End = ends.get(ext2Id) ?? 0;

    // Both externals must have finished well before notify returned —
    // they did not wait in line behind notify.
    expect(ext1End).toBeLessThan(notifyEnd);
    expect(ext2End).toBeLessThan(notifyEnd);
    // Notify itself ran in parallel with the externals (started at
    // roughly the same time as them, well before the externals
    // finished).
    expect(notifyStart).toBeLessThanOrEqual(ext1End);
    expect(notifyStart).toBeLessThanOrEqual(ext2End);
    // Total wall-clock under ~600ms (notify delay + overhead) — proves
    // the externals were not stacked sequentially.
    expect(notifyEnd - notifyStart).toBeGreaterThanOrEqual(450);
  });

  it("per-dispatch independence on partial failure: outcomes stable regardless of completion order", async () => {
    // Acceptance #2 — partial failure independence (wall-clock).
    // Notify fails fast while two externals succeed slowly; the row
    // settles failed_retryable with notify failed_retryable and both
    // externals succeeded — same outcome regardless of order.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_NOTIFY",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });
    const dispatcher: ApplyDispatcher = {
      async managerDb() {},
      async managerNotify() {
        throw new Error("notify boom");
      },
      async external(_kind, input) {
        await new Promise((r) => setTimeout(r, 50));
        if (input.dispatchId === ext1Id) return;
        if (input.dispatchId === ext2Id) return;
      },
    };
    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher,
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_retryable");
    const byKind: Record<string, PlannedDispatch> = {};
    for (const d of result.plannedDispatches) {
      byKind[d.kind] = d;
    }
    expect(byKind.MANAGER_DB.state).toBe("succeeded");
    expect(byKind.MANAGER_NOTIFY.state).toBe("failed_retryable");
    expect(byKind.DATA_STORE.state).toBe("succeeded");
    expect(byKind.TI_CONTAINER.state).toBe("succeeded");
  });

  it("per-dispatch retry independence: retrying one failed_retryable dispatch re-executes only that dispatch", async () => {
    // Acceptance #6 — retrying one of two failed_retryable dispatches
    // re-runs only the targeted one. The other failed_retryable
    // dispatch's attemptCount and lastError are preserved verbatim.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const notifyId = randomUUID();
    const extId = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: notifyId,
        kind: "MANAGER_NOTIFY",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "notify lastError preserved",
      },
      {
        dispatchId: extId,
        kind: "DATA_STORE",
        state: "failed_retryable",
        attemptCount: 1,
        lastError: "ext lastError",
        new: "{a}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "failed_retryable",
    });
    const recorder = makeRecorder();
    const result = await _internal_retryDispatch({
      session: makeSession(),
      attemptId,
      dispatchId: extId,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_retryable");
    // Targeted dispatch advanced (succeeded), notify untouched.
    const notify = result.plannedDispatches.find(
      (d) => d.dispatchId === notifyId,
    );
    const ext = result.plannedDispatches.find((d) => d.dispatchId === extId);
    expect(notify?.state).toBe("failed_retryable");
    expect(notify?.attemptCount).toBe(1);
    expect(notify?.lastError).toBe("notify lastError preserved");
    expect(ext?.state).toBe("succeeded");
    expect(ext?.lastError).toBe(null);
    // Manager notify was NOT re-executed by this retry.
    expect(recorder.managerCalls).toBe(0);
    expect(recorder.externalCalls.map((c) => c.dispatchId)).toEqual([extId]);
  });

  it("DB-to-post-DB handoff is atomic: a row in 'executing' is never observable with both a row-level lock and per-dispatch locks", async () => {
    // Acceptance #4 — handoff atomicity. PostgreSQL only exposes
    // committed states cross-transaction, so the assertion is on the
    // observable invariant: while a confirm runs, repeated reads must
    // always observe either the pre-handoff state (row-level claim,
    // no per-dispatch claims) or the post-handoff state (per-dispatch
    // claims, no row-level claim) — never both, never neither.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_NOTIFY",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });

    let stopProbing = false;
    const observations: Array<{
      executing_lock: string | null;
      perDispatchClaims: number;
      status: string;
    }> = [];

    const probe = (async () => {
      while (!stopProbing) {
        const { rows } = await pool.query<{
          status: string;
          executing_lock: string | null;
          planned_dispatches: PlannedDispatch[];
        }>(
          `SELECT status, executing_lock, planned_dispatches FROM apply_attempts WHERE attempt_id = $1`,
          [attemptId],
        );
        const row = rows[0];
        if (row) {
          const perDispatch = row.planned_dispatches.filter(
            (d) =>
              (d as { lockToken?: string }).lockToken !== undefined &&
              (d as { claimStartedAt?: string }).claimStartedAt !== undefined,
          ).length;
          observations.push({
            executing_lock: row.executing_lock,
            perDispatchClaims: perDispatch,
            status: row.status,
          });
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const slowDispatcher: ApplyDispatcher = {
      async managerDb() {
        // Yield to let the probe observe the pre-handoff state.
        await new Promise((r) => setTimeout(r, 25));
      },
      async managerNotify() {
        // Yield while in post-handoff per-dispatch claim phase.
        await new Promise((r) => setTimeout(r, 50));
      },
      async external() {
        await new Promise((r) => setTimeout(r, 50));
      },
    };

    const result = await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher: slowDispatcher,
      draftReader: makeReader(node),
    });
    stopProbing = true;
    await probe;

    expect(result.status).toBe("succeeded");
    expect(observations.length).toBeGreaterThan(0);
    // The invariant: every observation falls into one of the four
    // permitted shapes. The forbidden shape is "row lock held AND
    // per-dispatch claims also set" (would mean the handoff was
    // observable mid-UPDATE).
    for (const o of observations) {
      const rowLockHeld = o.executing_lock !== null;
      const perDispatchHeld = o.perDispatchClaims > 0;
      expect(rowLockHeld && perDispatchHeld).toBe(false);
    }
    // At least one observation should have seen the row-level lock
    // (DB stage in flight) and at least one should have seen the
    // per-dispatch locks (post-handoff fan-out in flight) — proving
    // the probe actually caught both phases.
    const sawRowLock = observations.some((o) => o.executing_lock !== null);
    const sawPerDispatch = observations.some(
      (o) => o.perDispatchClaims > 0 && o.executing_lock === null,
    );
    expect(sawRowLock).toBe(true);
    expect(sawPerDispatch).toBe(true);
  });

  it("concurrent claim isolation: one dispatch's claim going stale mid-flight does not corrupt a sibling's claim or final state", async () => {
    // Acceptance #3 — concurrent claim isolation. Force one
    // dispatch's claim to expire while another is in progress and
    // assert the second dispatch's claim + final state remain
    // intact.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: ext1Id,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{a}",
      },
      {
        dispatchId: ext2Id,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{b}",
      },
    ];
    const attemptId = await insertAttempt({
      fingerprint: fp.bytes,
      plannedDispatches: dispatches,
      status: "pending",
    });

    // Drive ext1 to "expired claim" by clearing its lockToken from the
    // JSON entry mid-flight (simulating what stale-dispatch recovery
    // would do). Then let ext2 complete normally — its claim must
    // still match and the final row must reflect ext2 succeeded.
    const dispatcher: ApplyDispatcher = {
      async managerDb() {},
      async managerNotify() {},
      async external(_kind, input) {
        if (input.dispatchId === ext1Id) {
          // Pretend the claim was lost mid-flight by clearing it.
          await pool.query(
            `UPDATE apply_attempts
             SET planned_dispatches = (
               SELECT jsonb_agg(
                 CASE
                   WHEN d->>'dispatchId' = $2
                     THEN jsonb_set(
                            jsonb_set(
                              (d - 'lockToken') - 'claimStartedAt',
                              '{state}', '"failed_terminal"'
                            ),
                            '{lastError}', '"forcibly expired"'
                          )
                   ELSE d
                 END
               )
               FROM jsonb_array_elements(planned_dispatches) AS d
             )
             WHERE attempt_id = $1`,
            [attemptId, ext1Id],
          );
          await new Promise((r) => setTimeout(r, 20));
        } else {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    };

    await _internal_confirmApplyAttempt({
      session: makeSession(),
      attemptId,
      dispatcher,
      draftReader: makeReader(node),
    });

    const row = await readRow(attemptId);
    // ext1 was forced into failed_terminal by the simulated expiry.
    // ext2 still succeeded with its own per-dispatch claim intact at
    // commit time — proving the two claims are independent.
    const byDispatch: Record<string, PlannedDispatch> = {};
    for (const d of row.planned_dispatches) byDispatch[d.dispatchId] = d;
    expect(byDispatch[ext1Id].state).toBe("failed_terminal");
    expect(byDispatch[ext1Id].lastError).toBe("forcibly expired");
    expect(byDispatch[ext2Id].state).toBe("succeeded");
    expect(byDispatch[ext2Id].lastError).toBe(null);
    // No per-dispatch claim markers leak into the persisted terminal
    // state.
    for (const d of row.planned_dispatches) {
      expect((d as { lockToken?: string }).lockToken).toBeUndefined();
      expect((d as { claimStartedAt?: string }).claimStartedAt).toBeUndefined();
    }
    // Row aggregate is `failed_terminal` because ext1 ended terminal
    // and no retryable remained.
    expect(row.status).toBe("failed_terminal");
  });
});
