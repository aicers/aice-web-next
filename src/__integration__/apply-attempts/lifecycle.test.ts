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

describe("Lifecycle — APPLY_DISPATCH_MAX_ATTEMPTS cap on a post-DB external (#333: no cross-dispatch cascade)", () => {
  it("cap reached on one external lands it in failed_terminal but does NOT cascade unrelated queued externals — they are advanced and run, and the row settles failed_terminal with expires_at rewritten to retention", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const ext1Id = randomUUID();
    const ext2Id = randomUUID();
    // Pre-seed attemptCount at MAX_ATTEMPTS - 1 so the next failure trips the cap.
    const cap = Number(process.env.APPLY_DISPATCH_MAX_ATTEMPTS ?? "3");
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
    const result = await _internal_retryDispatch({
      session: makeSession(),
      attemptId,
      dispatchId: ext1Id,
      dispatcher: makeDispatcher(recorder, { failExternal: new Set([ext1Id]) }),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("failed_terminal");
    expect(result.plannedDispatches[1].state).toBe("failed_terminal");
    // Phase Node-12 (#333): the cross-dispatch cascade on cap is
    // gone for post-DB stages — external2 is advanced and run, and
    // (with no `failExternal` for it) succeeds with its own observed
    // outcome. The row still settles `failed_terminal` because
    // external1 is structurally non-retryable and no retryable
    // dispatch remains.
    expect(result.plannedDispatches[2].state).toBe("succeeded");
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
  async function setupRetryRow(): Promise<{
    attemptId: string;
    ext1: string;
    ext2: string;
  }> {
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
        lastError: "x",
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
    const { attemptId, ext2 } = await setupRetryRow();
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

  it("retry of a failed_retryable dispatch resumes and succeeds", async () => {
    const { attemptId, ext1 } = await setupRetryRow();
    const node = snapshot();
    const recorder = makeRecorder();
    const result = await _internal_retryDispatch({
      session: makeSession(),
      attemptId,
      dispatchId: ext1,
      dispatcher: makeDispatcher(recorder),
      draftReader: makeReader(node),
    });
    expect(result.status).toBe("succeeded");
    expect(recorder.externalCalls.map((c) => c.dispatchId)).toContain(ext1);
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
