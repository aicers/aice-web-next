import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import {
  computeDraftFingerprint,
  type NodeDraftSnapshot,
} from "@/lib/node/apply-attempt-lifecycle";
import type { PlannedDispatch } from "@/lib/node/apply-attempt-types";

/**
 * DB-backed integration tests for the `confirmApplyAttempt` and
 * `retryDispatch` server actions (#361). The lifecycle module's
 * direct-DB tests in `lifecycle.test.ts` cover the state machine
 * itself with mock dispatchers; this file covers the wrapper that
 * binds the lifecycle to the production GraphQL transport, the
 * `(old fresh, new frozen)` retry contract, the apply fan-out
 * order, the partial-failure + retry recovery path, and the
 * `node.apply` audit-once contract.
 *
 * Mock seam:
 *
 *   - Manager + external GraphQL is mocked (`@/lib/graphql/client`,
 *     `@/lib/graphql/external-client`) so we can drive precise
 *     dispatch sequences and observe exact `(old, new)` payloads
 *     without spinning up real Giganto / Tivan.
 *   - `getCurrentSession` is mocked because the `"use server"`
 *     wrapper resolves the session inside the action; we don't
 *     have a Next.js request cookie in this harness.
 *   - The apply-attempts DB is real (DATABASE_URL → postgres) so
 *     fingerprint checks, claim guards, sequential advance, and
 *     guarded UPDATEs run end to end against PostgreSQL.
 *   - The audit logger is mocked because the audit DB write is
 *     a side effect we want to count without persisting test rows
 *     into `audit_db`.
 */

const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());
const mockTivanClient = vi.hoisted(() => vi.fn());
const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));
vi.mock("@/lib/graphql/external-client", () => ({
  gigantoClient: mockGigantoClient,
  tivanClient: mockTivanClient,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/auth_db";

let pool: pg.Pool;
let testActorId: string;
const testUsername = `confirm-retry-test-${randomUUID()}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const passwordHash = await argon2.hash("not-used", { type: argon2.argon2id });
  const { rows } = await pool.query<{ id: string }>(
    `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
     INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
     VALUES ($1, $1, $2, (SELECT id FROM role), false)
     RETURNING id`,
    [testUsername, passwordHash],
  );
  testActorId = rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM accounts WHERE username = $1", [testUsername]);
  await pool.end();
});

afterEach(async () => {
  await pool.query("DELETE FROM apply_attempts WHERE created_by = $1", [
    testActorId,
  ]);
});

beforeEach(() => {
  mockGraphqlRequest.mockReset();
  mockGigantoClient.mockReset();
  mockTivanClient.mockReset();
  mockGetCurrentSession.mockReset();
  mockAuditRecord.mockReset();
  mockGetCurrentSession.mockResolvedValue(makeSession(testActorId));
});

function makeSession(actorId: string): AuthSession {
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
    externalServices: [
      {
        kind: "DATA_STORE",
        key: "k1",
        status: "ENABLED",
        draft: "{frozen-ds}",
      },
    ],
    ...overrides,
  };
}

function nodePayload(snap: NodeDraftSnapshot): { node: NodeDraftSnapshot } {
  return { node: snap };
}

async function insertAttempt(
  fingerprint: Buffer,
  plannedDispatches: PlannedDispatch[],
  status: string,
): Promise<string> {
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO apply_attempts (
       attempt_id, node_id, draft_fingerprint, planned_dispatches,
       created_by, audit_actor, expires_at, status
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, $7)`,
    [
      attemptId,
      "node-1",
      fingerprint,
      JSON.stringify(plannedDispatches),
      testActorId,
      new Date(Date.now() + 30 * 60 * 1000),
      status,
    ],
  );
  return attemptId;
}

interface OutboundEvent {
  channel:
    | "manager-applyNode"
    | "manager-readNode"
    | "giganto-config"
    | "giganto-update";
  payload?: { old?: string; new?: string };
}

function recordOutbound(
  events: OutboundEvent[],
  snap: NodeDraftSnapshot,
): void {
  // The first manager call inside the executor is step 5a's
  // canonical-node read (NODE_DETAIL_QUERY). The second is the
  // applyNode mutation. We distinguish them by inspecting whether
  // the variables contain a `node` key.
  mockGraphqlRequest.mockImplementation(async (_doc, vars) => {
    const v = (vars ?? {}) as Record<string, unknown>;
    if ("node" in v) {
      events.push({ channel: "manager-applyNode" });
      return { applyNode: "node-1" };
    }
    events.push({ channel: "manager-readNode" });
    return nodePayload(snap);
  });
}

function recordGiganto(
  events: OutboundEvent[],
  configReads: Array<Record<string, unknown>>,
  failOnUpdateOnce = false,
): void {
  let failed = false;
  mockGigantoClient.mockImplementation(async (_doc, vars) => {
    if (vars === undefined) {
      events.push({ channel: "giganto-config" });
      const next = configReads.shift();
      return {
        config: next ?? {
          ackTransmission: 0,
          dataDir: "/d",
          exportDir: "/e",
          graphqlSrvAddr: "g",
          ingestSrvAddr: "i",
          maxMbOfLevelBase: "0",
          maxOpenFiles: 0,
          maxSubcompactions: "0",
          numOfThread: 0,
          publishSrvAddr: "p",
          retention: "1d",
        },
      };
    }
    const payload = vars as { old: string; new: string };
    events.push({
      channel: "giganto-update",
      payload: { old: payload.old, new: payload.new },
    });
    if (failOnUpdateOnce && !failed) {
      failed = true;
      throw new Error("upstream giganto rejected");
    }
    return { updateConfig: {} };
  });
}

describe("confirmApplyAttempt — apply fan-out order", () => {
  it("dispatches applyNode first, then per-external updateConfig (manager-first ordering)", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
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
        new: "{frozen-ds}",
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    const events: OutboundEvent[] = [];
    recordOutbound(events, node);
    recordGiganto(events, []);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const result = await confirmApplyAttempt({ attemptId });

    expect(result.status).toBe("succeeded");
    // Order: manager-readNode (wrapper-level node-scope/existence
    // recheck via `assertAttemptNodeInScope`) → manager-readNode
    // (step 5a fresh canonical-node read for fingerprint recompute)
    // → manager-applyNode (step 5d) → giganto-config (external `old`
    // fresh) → giganto-update.
    const order = events.map((e) => e.channel);
    expect(order[0]).toBe("manager-readNode");
    expect(order[1]).toBe("manager-readNode");
    expect(order[2]).toBe("manager-applyNode");
    expect(order.slice(3)).toEqual(["giganto-config", "giganto-update"]);
  });
});

describe("retry safety — old fresh, new frozen", () => {
  it("retry observes config fetched twice; old is the second fetch's result; new is byte-identical to the first attempt's new", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
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
        new: "{frozen-ds}",
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    const events: OutboundEvent[] = [];
    recordOutbound(events, node);
    // Two distinct `config` snapshots so we can prove `old` was the
    // *second* read on the retry, not the first.
    recordGiganto(
      events,
      [
        {
          ackTransmission: 0,
          dataDir: "/d",
          exportDir: "/e",
          graphqlSrvAddr: "g",
          ingestSrvAddr: "first-ingest",
          maxMbOfLevelBase: "0",
          maxOpenFiles: 0,
          maxSubcompactions: "0",
          numOfThread: 0,
          publishSrvAddr: "p",
          retention: "1d",
        },
        {
          ackTransmission: 0,
          dataDir: "/d",
          exportDir: "/e",
          graphqlSrvAddr: "g",
          ingestSrvAddr: "second-ingest",
          maxMbOfLevelBase: "0",
          maxOpenFiles: 0,
          maxSubcompactions: "0",
          numOfThread: 0,
          publishSrvAddr: "p",
          retention: "1d",
        },
      ],
      /* failOnUpdateOnce */ true,
    );

    const { confirmApplyAttempt, retryDispatch } = await import(
      "@/lib/node/apply-actions"
    );
    // First confirm: external fails → row stays in `failed_retryable`.
    const after = await confirmApplyAttempt({ attemptId });
    expect(after.status).toBe("failed_retryable");
    const externalDispatchId = after.plannedDispatches.find(
      (d) => d.kind === "DATA_STORE",
    )?.dispatchId;
    expect(externalDispatchId).toBeDefined();

    // Retry the failed external. Manager step is NOT re-run (the
    // manager already succeeded), only the external resumes.
    if (!externalDispatchId) throw new Error("no external dispatch found");
    const retried = await retryDispatch({
      attemptId,
      dispatchId: externalDispatchId,
    });
    expect(retried.status).toBe("succeeded");

    const updates = events.filter((e) => e.channel === "giganto-update");
    expect(updates).toHaveLength(2);
    // `new` is byte-identical across both attempts: the frozen
    // payload from `apply_attempts.planned_dispatches`.
    expect(updates[0].payload?.new).toBe("{frozen-ds}");
    expect(updates[1].payload?.new).toBe("{frozen-ds}");
    // `old` is the fresh fetch each time. The retry's `old` must
    // include the SECOND read's distinguishing field.
    expect(updates[0].payload?.old).toContain("first-ingest");
    expect(updates[1].payload?.old).toContain("second-ingest");
    // And the recorder shows config was fetched twice (once per
    // attempt), even though `new` is frozen.
    expect(events.filter((e) => e.channel === "giganto-config")).toHaveLength(
      2,
    );
  });
});

describe("partial failure + retry recovery — sequential-advance contract", () => {
  it("Giganto fails once, retry succeeds, Tivan advances under the resume rule, row settles to succeeded", async () => {
    const node = snapshot({
      externalServices: [
        {
          kind: "DATA_STORE",
          key: "k1",
          status: "ENABLED",
          draft: "{frozen-ds}",
        },
        {
          kind: "TI_CONTAINER",
          key: "k2",
          status: "ENABLED",
          draft: "{frozen-tc}",
        },
      ],
    });
    const fp = computeDraftFingerprint(node);
    const dsId = randomUUID();
    const tcId = randomUUID();
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: dsId,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{frozen-ds}",
      },
      {
        dispatchId: tcId,
        kind: "TI_CONTAINER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: "{frozen-tc}",
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    const events: OutboundEvent[] = [];
    recordOutbound(events, node);
    recordGiganto(events, [], /* failOnUpdateOnce */ true);
    mockTivanClient.mockImplementation(async (_doc, vars) => {
      if (vars === undefined) {
        return {
          config: {
            excelData: null,
            graphqlSrvAddr: "g",
            originMitre: null,
            translateMitre: "t",
          },
        };
      }
      return { updateConfig: {} };
    });

    const { confirmApplyAttempt, retryDispatch } = await import(
      "@/lib/node/apply-actions"
    );
    const first = await confirmApplyAttempt({ attemptId });
    expect(first.status).toBe("failed_retryable");
    // Tivan must NOT have run yet — sequential-advance stops on the
    // first failure.
    expect(mockTivanClient).not.toHaveBeenCalled();

    const retried = await retryDispatch({ attemptId, dispatchId: dsId });
    expect(retried.status).toBe("succeeded");
    // Tivan ran once after the resumed Giganto succeeded.
    const tivanUpdateCalls = mockTivanClient.mock.calls.filter(
      (c) => c[1] !== undefined,
    );
    expect(tivanUpdateCalls).toHaveLength(1);

    // Audit emitted exactly once: on the retry that drove the row
    // to `succeeded`. The first confirm settled to
    // `failed_retryable` and emits no `node.apply` row.
    const applyAudits = mockAuditRecord.mock.calls.filter(
      (c) => c[0].action === "node.apply",
    );
    expect(applyAudits).toHaveLength(1);
    expect(applyAudits[0][0].targetId).toBe("node-1");
    expect(applyAudits[0][0].details.appliedServices).toEqual(
      expect.arrayContaining(["DATA_STORE", "TI_CONTAINER"]),
    );
  });
});

describe("stale-plan abort — pre-claim path", () => {
  it("save-draft mutation between create and confirm flips the row to status=stale and prevents the manager mutation", async () => {
    const node = snapshot();
    const drifted = snapshot({ name: "drifted" });
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
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
        new: "{frozen-ds}",
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    const events: OutboundEvent[] = [];
    // Reader returns drifted state — fingerprint mismatch.
    recordOutbound(events, drifted);
    recordGiganto(events, []);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { StalePlanError } = await import("@/lib/node/errors");
    await expect(confirmApplyAttempt({ attemptId })).rejects.toBeInstanceOf(
      StalePlanError,
    );
    // No applyNode mutation reached the wire.
    expect(
      events.filter((e) => e.channel === "manager-applyNode"),
    ).toHaveLength(0);
    // No giganto update either.
    expect(events.filter((e) => e.channel === "giganto-update")).toHaveLength(
      0,
    );
    // Persisted row has been marked stale with the lock cleared.
    const { rows } = await pool.query(
      `SELECT status, executing_lock, claim_started_at FROM apply_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(rows[0].status).toBe("stale");
    expect(rows[0].executing_lock).toBeNull();
    expect(rows[0].claim_started_at).toBeNull();
    // No node.apply audit was emitted.
    expect(
      mockAuditRecord.mock.calls.filter((c) => c[0].action === "node.apply"),
    ).toHaveLength(0);
  });
});

describe("node.apply audit — persisted once-only emission", () => {
  it("idempotent re-confirm of a succeeded row does NOT emit a duplicate node.apply (succeeded_audit_emitted_at guard)", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
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
        new: "{frozen-ds}",
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    const events: OutboundEvent[] = [];
    recordOutbound(events, node);
    recordGiganto(events, []);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");

    const first = await confirmApplyAttempt({ attemptId });
    expect(first.status).toBe("succeeded");
    const firstApplyAudits = mockAuditRecord.mock.calls.filter(
      (c) => c[0].action === "node.apply",
    );
    expect(firstApplyAudits).toHaveLength(1);

    // Re-confirm the same already-succeeded row. The lifecycle's
    // step-1 SELECT short-circuits ("already terminal"), and the
    // wrapper's atomic test-and-set on succeeded_audit_emitted_at
    // matches zero rows because the column is now non-NULL. No
    // duplicate node.apply may be emitted.
    const second = await confirmApplyAttempt({ attemptId });
    expect(second.status).toBe("succeeded");
    const allApplyAudits = mockAuditRecord.mock.calls.filter(
      (c) => c[0].action === "node.apply",
    );
    expect(allApplyAudits).toHaveLength(1);

    // And the column is set on the persisted row.
    const { rows } = await pool.query<{
      succeeded_audit_emitted_at: Date | null;
    }>(
      `SELECT succeeded_audit_emitted_at FROM apply_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(rows[0].succeeded_audit_emitted_at).not.toBeNull();
  });
});

describe("wrapper-level node-scope recheck — round 2 acceptance", () => {
  // Acceptance for the round-2 reviewer finding: an actor whose
  // customer scope changes between confirm and retry can no longer
  // drive an external `updateConfig` against the now-out-of-scope
  // node — even though the external dispatcher otherwise talks to
  // the deployment-global Giganto/Tivan endpoints with no per-node
  // guard of its own.
  it("retryDispatch rejects with NodePermissionError after the actor's customer scope shrinks to exclude the attempt's node", async () => {
    // Seed a tenant-scoped account so the wrapper-level recheck
    // (which short-circuits for `customers:access-all` callers)
    // actually fires.
    const tenantUsername = `confirm-retry-tenant-${randomUUID()}`;
    const passwordHash = await argon2.hash("not-used", {
      type: argon2.argon2id,
    });
    const { rows: tenantRows } = await pool.query<{ id: string }>(
      `WITH role AS (SELECT id FROM roles WHERE name = 'Tenant Administrator' LIMIT 1)
       INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, (SELECT id FROM role), false)
       RETURNING id`,
      [tenantUsername, passwordHash],
    );
    const tenantActorId = tenantRows[0].id;
    // Also need a customer row so we can attach the account to it.
    const customerSlug = `scope-test-customer-${randomUUID()}`;
    const { rows: customerRows } = await pool.query<{ id: number }>(
      `INSERT INTO customers (name, description, database_name) VALUES ($1, '', $1) RETURNING id`,
      [customerSlug],
    );
    const customerId = customerRows[0].id;
    await pool.query(
      `INSERT INTO account_customer (account_id, customer_id) VALUES ($1, $2)`,
      [tenantActorId, customerId],
    );

    try {
      // Build the attempt as the tenant actor against a node in
      // their scope.
      mockGetCurrentSession.mockResolvedValue({
        ...makeSession(tenantActorId),
        roles: ["Tenant Administrator"],
      });
      const node = snapshot({
        profile: {
          customerId: String(customerId),
          description: "",
          hostname: "h",
        },
      });
      const fp = computeDraftFingerprint(node);
      const dsId = randomUUID();
      const dispatches: PlannedDispatch[] = [
        {
          dispatchId: randomUUID(),
          kind: "MANAGER",
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
        },
        {
          dispatchId: dsId,
          kind: "DATA_STORE",
          state: "failed_retryable",
          attemptCount: 1,
          lastError: "first attempt failed",
          new: "{frozen-ds}",
        },
      ];
      const attemptId = await pool.query<{ attempt_id: string }>(
        `INSERT INTO apply_attempts (
           attempt_id, node_id, draft_fingerprint, planned_dispatches,
           created_by, audit_actor, expires_at, status
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, 'failed_retryable')
         RETURNING attempt_id`,
        [
          randomUUID(),
          "node-1",
          fp.bytes,
          JSON.stringify(dispatches),
          tenantActorId,
          new Date(Date.now() + 30 * 60 * 1000),
        ],
      );
      const aid = attemptId.rows[0].attempt_id;

      // Now revoke the actor's scope BEFORE the retry. The original
      // attempt row stays — only the actor's `account_customer`
      // mapping changes. The wrapper-level scope recheck must fail
      // before any external dispatch reaches the wire.
      await pool.query(`DELETE FROM account_customer WHERE account_id = $1`, [
        tenantActorId,
      ]);

      // The wrapper does a canonical-node read for tenant-scoped
      // callers. Stub it to return the same out-of-scope node.
      const events: OutboundEvent[] = [];
      mockGraphqlRequest.mockImplementation(async (_doc, vars) => {
        const v = (vars ?? {}) as Record<string, unknown>;
        if ("node" in v) {
          events.push({ channel: "manager-applyNode" });
          return { applyNode: "node-1" };
        }
        events.push({ channel: "manager-readNode" });
        return nodePayload(node);
      });
      mockGigantoClient.mockImplementation(async () => {
        throw new Error(
          "external dispatcher MUST NOT be reached when the wrapper rejects",
        );
      });

      const { retryDispatch } = await import("@/lib/node/apply-actions");
      const { NodePermissionError } = await import("@/lib/node/errors");
      await expect(
        retryDispatch({ attemptId: aid, dispatchId: dsId }),
      ).rejects.toBeInstanceOf(NodePermissionError);

      // No external dispatch reached the wire; no audit emitted.
      expect(mockGigantoClient).not.toHaveBeenCalled();
      expect(events.filter((e) => e.channel === "manager-applyNode")).toEqual(
        [],
      );
      expect(
        mockAuditRecord.mock.calls.filter((c) => c[0].action === "node.apply"),
      ).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM apply_attempts WHERE created_by = $1`, [
        tenantActorId,
      ]);
      await pool.query(`DELETE FROM account_customer WHERE account_id = $1`, [
        tenantActorId,
      ]);
      await pool.query("DELETE FROM accounts WHERE id = $1", [tenantActorId]);
      await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
    }
  });
});

describe("audit-emission recovery — round 2 acceptance", () => {
  it("recoverPendingNodeApplyAudits re-emits the audit and marks the slot completed for a stuck succeeded row", async () => {
    // Seed a `succeeded` row whose audit slot was claimed but never
    // marked completed (process-death-equivalent). The staleness
    // threshold is APPLY_EXECUTING_STALE_MS — stamp the column far
    // enough in the past that the recovery sweep picks it up.
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: randomUUID(),
        kind: "DATA_STORE",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
        new: "{frozen-ds}",
      },
    ];
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO apply_attempts (
         attempt_id, node_id, draft_fingerprint, planned_dispatches,
         created_by, audit_actor, expires_at, status, succeeded_audit_emitted_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, 'succeeded', NOW() - INTERVAL '7 hours')`,
      [
        attemptId,
        "node-1",
        fp.bytes,
        JSON.stringify(dispatches),
        testActorId,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ],
    );

    const { recoverPendingNodeApplyAudits } = await import(
      "@/lib/node/apply-attempt-cleanup"
    );
    const recovered = await recoverPendingNodeApplyAudits();
    expect(recovered).toBe(1);

    // The audit was re-emitted by the cleanup sweep using the row's
    // persisted actor (created_by) and node id — not a system actor.
    const applyAudits = mockAuditRecord.mock.calls.filter(
      (c) => c[0].action === "node.apply",
    );
    expect(applyAudits).toHaveLength(1);
    expect(applyAudits[0][0].actor).toBe(testActorId);
    expect(applyAudits[0][0].targetId).toBe("node-1");
    expect(applyAudits[0][0].details.appliedServices).toEqual(["DATA_STORE"]);

    // `completed_at` is now set, so a second sweep is a no-op (the
    // staleness predicate would still match if the row were stuck,
    // but the candidate SELECT requires `completed_at IS NULL`).
    const { rows } = await pool.query<{
      succeeded_audit_completed_at: Date | null;
    }>(
      `SELECT succeeded_audit_completed_at FROM apply_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(rows[0].succeeded_audit_completed_at).not.toBeNull();
    mockAuditRecord.mockClear();
    expect(await recoverPendingNodeApplyAudits()).toBe(0);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

describe("single-actor ApplyAttempt", () => {
  it("rejects a different actor's confirm before any DB mutation or dispatch", async () => {
    const node = snapshot();
    const fp = computeDraftFingerprint(node);
    const dispatches: PlannedDispatch[] = [
      {
        dispatchId: randomUUID(),
        kind: "MANAGER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
    ];
    const attemptId = await insertAttempt(fp.bytes, dispatches, "pending");

    // Switch the session to a different account id.
    const otherUsername = `confirm-retry-other-${randomUUID()}`;
    const passwordHash = await argon2.hash("not-used", {
      type: argon2.argon2id,
    });
    const { rows } = await pool.query<{ id: string }>(
      `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
       INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, (SELECT id FROM role), false)
       RETURNING id`,
      [otherUsername, passwordHash],
    );
    try {
      mockGetCurrentSession.mockResolvedValue(makeSession(rows[0].id));

      const events: OutboundEvent[] = [];
      recordOutbound(events, node);
      recordGiganto(events, []);

      const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
      const { ApplyAttemptNotFoundError } = await import("@/lib/node/errors");
      await expect(confirmApplyAttempt({ attemptId })).rejects.toBeInstanceOf(
        ApplyAttemptNotFoundError,
      );
      // No outbound graphql, no audit.
      expect(events).toHaveLength(0);
      expect(mockGigantoClient).not.toHaveBeenCalled();
      expect(mockAuditRecord).not.toHaveBeenCalled();
    } finally {
      await pool.query("DELETE FROM accounts WHERE username = $1", [
        otherUsername,
      ]);
    }
  });

  it("returns ApplyAttemptNotFoundError after the creator's account is deleted (cascade) — round 4 acceptance", async () => {
    // Round-4 acceptance: "A is deleted → on delete cascade removes
    // the attempt row; a follow-up confirm/retry returns NotFound."
    //
    // Realistic interpretation: A's deletion invalidates A's sessions
    // (the JWT layer joins sessions to accounts and rejects the missing
    // join), so A cannot make the follow-up call. The acceptance
    // contract is testable as: any *other* valid caller attempting
    // confirm/retry of A's cascade-deleted attemptId surfaces NotFound,
    // because the row is gone. That is what the cascade behavior on
    // `apply_attempts.created_by REFERENCES accounts(id) ON DELETE
    // CASCADE` delivers.
    //
    // This test seeds an account A, builds an attempt for A, deletes
    // A (which cascade-removes the attempt row), then drives a
    // confirm/retry from a *different* valid session and asserts the
    // wrapper's `readApplyAttempt` returns null and the surface is
    // `ApplyAttemptNotFoundError` — NOT a session-layer rejection.
    const creatorUsername = `confirm-retry-creator-${randomUUID()}`;
    const otherUsername = `confirm-retry-other-${randomUUID()}`;
    const passwordHash = await argon2.hash("not-used", {
      type: argon2.argon2id,
    });
    const { rows: creatorRows } = await pool.query<{ id: string }>(
      `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
       INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, (SELECT id FROM role), false)
       RETURNING id`,
      [creatorUsername, passwordHash],
    );
    const creatorId = creatorRows[0].id;
    const { rows: otherRows } = await pool.query<{ id: string }>(
      `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
       INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, (SELECT id FROM role), false)
       RETURNING id`,
      [otherUsername, passwordHash],
    );
    const otherId = otherRows[0].id;
    try {
      // Seed an attempt owned by the creator, with a manager dispatch
      // queued and an external dispatch already failed_retryable so we
      // can attempt both `confirm` and `retry` paths against it.
      const node = snapshot();
      const fp = computeDraftFingerprint(node);
      const mgrId = randomUUID();
      const dsId = randomUUID();
      const dispatches: PlannedDispatch[] = [
        {
          dispatchId: mgrId,
          kind: "MANAGER",
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
        },
        {
          dispatchId: dsId,
          kind: "DATA_STORE",
          state: "failed_retryable",
          attemptCount: 1,
          lastError: "transient",
          new: "{frozen-ds}",
        },
      ];
      const attemptId = randomUUID();
      await pool.query(
        `INSERT INTO apply_attempts (
           attempt_id, node_id, draft_fingerprint, planned_dispatches,
           created_by, audit_actor, expires_at, status
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, $7)`,
        [
          attemptId,
          "node-1",
          fp.bytes,
          JSON.stringify(dispatches),
          creatorId,
          new Date(Date.now() + 30 * 60 * 1000),
          "failed_retryable",
        ],
      );

      // Verify the cascade FK is wired before we delete: the row
      // currently exists.
      const { rowCount: pre } = await pool.query(
        `SELECT 1 FROM apply_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(pre).toBe(1);

      // Delete the creator. As of round 8 the cascade is implemented
      // by a BEFORE-DELETE trigger on `accounts` that explicitly
      // removes `apply_attempts` rows that are NOT succeeded-audit-
      // pending — the FK on `created_by` is `ON DELETE SET NULL` so
      // it cannot delete the row directly. For the `failed_retryable`
      // attempt below, the trigger's predicate matches and the row
      // is removed, so the existing cascade observable still holds
      // (the round-8 preservation only applies to
      // `status='succeeded' AND succeeded_audit_completed_at IS NULL`,
      // which is exercised by the dedicated test below).
      await pool.query("DELETE FROM accounts WHERE id = $1", [creatorId]);
      const { rowCount: post } = await pool.query(
        `SELECT 1 FROM apply_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(post).toBe(0);

      // A different valid actor attempts confirm/retry. Their session
      // is valid (they exist), but the attempt row is gone, so the
      // wrapper's `readApplyAttempt` returns null and the surface is
      // `ApplyAttemptNotFoundError` — NOT a session-layer
      // `NodePermissionError`.
      mockGetCurrentSession.mockResolvedValue(makeSession(otherId));
      mockGraphqlRequest.mockImplementation(async () => {
        throw new Error(
          "manager dispatcher MUST NOT be reached when the attempt is gone",
        );
      });
      mockGigantoClient.mockImplementation(async () => {
        throw new Error(
          "external dispatcher MUST NOT be reached when the attempt is gone",
        );
      });

      const { confirmApplyAttempt, retryDispatch } = await import(
        "@/lib/node/apply-actions"
      );
      const { ApplyAttemptNotFoundError } = await import("@/lib/node/errors");
      await expect(confirmApplyAttempt({ attemptId })).rejects.toBeInstanceOf(
        ApplyAttemptNotFoundError,
      );
      await expect(
        retryDispatch({ attemptId, dispatchId: dsId }),
      ).rejects.toBeInstanceOf(ApplyAttemptNotFoundError);

      // Zero outbound dispatches in either path, zero audit emissions.
      expect(mockGraphqlRequest).not.toHaveBeenCalled();
      expect(mockGigantoClient).not.toHaveBeenCalled();
      expect(mockAuditRecord).not.toHaveBeenCalled();
    } finally {
      await pool.query("DELETE FROM accounts WHERE username = $1", [
        otherUsername,
      ]);
      // creatorUsername was already deleted in the test body; cleanup
      // is best-effort in case the test bailed before the delete.
      await pool.query("DELETE FROM accounts WHERE username = $1", [
        creatorUsername,
      ]);
    }
  });

  it("succeeded-audit-pending rows survive creator deletion and the audit recovery sweep emits node.apply (round 8)", async () => {
    // Round-8 reviewer finding: until this round, the
    // `apply_attempts.created_by` FK was `ON DELETE CASCADE`, so
    // deleting the creator wiped the row out from under the audit
    // recovery sweep. A row that reached `succeeded` but never made
    // it through `succeeded_audit_completed_at` (e.g. process death
    // between the success commit and the audit DB INSERT) would end
    // up with zero `node.apply` audits.
    //
    // Round 8 fixes this by: (a) snapshotting the actor into a
    // non-cascading `audit_actor` column at insert time; (b) replacing
    // `ON DELETE CASCADE` on `created_by` with `ON DELETE SET NULL`;
    // (c) installing a BEFORE-DELETE trigger on `accounts` that
    // explicitly removes apply_attempts rows that are NOT
    // succeeded-audit-pending, so the existing cascade observable
    // still holds for the common case while audit-pending rows
    // survive for the recovery sweep.
    const creatorUsername = `audit-pending-creator-${randomUUID()}`;
    const passwordHash = await argon2.hash("not-used", {
      type: argon2.argon2id,
    });
    const { rows: creatorRows } = await pool.query<{ id: string }>(
      `WITH role AS (SELECT id FROM roles WHERE name = 'System Administrator' LIMIT 1)
       INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, (SELECT id FROM role), false)
       RETURNING id`,
      [creatorUsername, passwordHash],
    );
    const creatorId = creatorRows[0].id;
    let attemptId: string | null = null;
    try {
      const node = snapshot();
      const fp = computeDraftFingerprint(node);
      const dispatches: PlannedDispatch[] = [
        {
          dispatchId: randomUUID(),
          kind: "MANAGER",
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
        },
        {
          dispatchId: randomUUID(),
          kind: "DATA_STORE",
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
          new: "{frozen-ds}",
        },
      ];
      attemptId = randomUUID();
      // succeeded with the audit slot CLAIMED but completion never
      // landed, AND old enough that the recovery sweep picks it up.
      // `expires_at` is set to retain the row long enough for both
      // the "in window" check and the cleanup pass.
      await pool.query(
        `INSERT INTO apply_attempts (
           attempt_id, node_id, draft_fingerprint, planned_dispatches,
           created_by, audit_actor, expires_at, status,
           succeeded_audit_emitted_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, 'succeeded',
                   NOW() - INTERVAL '7 hours')`,
        [
          attemptId,
          "node-1",
          fp.bytes,
          JSON.stringify(dispatches),
          creatorId,
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ],
      );

      // Sanity check: the row exists before we delete the creator.
      const { rowCount: pre } = await pool.query(
        `SELECT 1 FROM apply_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(pre).toBe(1);

      // Delete the creator. Round 8: the BEFORE-DELETE trigger
      // exempts succeeded-audit-pending rows, so this row survives
      // with `created_by` set to NULL by the FK SET NULL action.
      await pool.query("DELETE FROM accounts WHERE id = $1", [creatorId]);
      const { rows: postRows } = await pool.query<{
        created_by: string | null;
        audit_actor: string;
        succeeded_audit_completed_at: Date | null;
      }>(
        `SELECT created_by, audit_actor, succeeded_audit_completed_at
         FROM apply_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(postRows).toHaveLength(1);
      expect(postRows[0].created_by).toBeNull();
      expect(postRows[0].audit_actor).toBe(creatorId);

      // Drive the audit recovery sweep. It must emit node.apply with
      // the snapshotted actor (audit_actor) — not NULL, not a system
      // sentinel — and mark the row's audit completed.
      const { recoverPendingNodeApplyAudits } = await import(
        "@/lib/node/apply-attempt-cleanup"
      );
      const recovered = await recoverPendingNodeApplyAudits();
      expect(recovered).toBe(1);

      const applyAudits = mockAuditRecord.mock.calls.filter(
        (c) => c[0].action === "node.apply",
      );
      expect(applyAudits).toHaveLength(1);
      // Critical: the actor is the snapshotted creator id, not NULL.
      expect(applyAudits[0][0].actor).toBe(creatorId);
      expect(applyAudits[0][0].targetId).toBe("node-1");
      expect(applyAudits[0][0].correlationId).toBe(attemptId);
      expect(applyAudits[0][0].details.appliedServices).toEqual(["DATA_STORE"]);

      // Completion marker landed; the next sweep would skip this row.
      const { rows: finalRows } = await pool.query<{
        succeeded_audit_completed_at: Date | null;
      }>(
        `SELECT succeeded_audit_completed_at FROM apply_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(finalRows[0].succeeded_audit_completed_at).not.toBeNull();
    } finally {
      if (attemptId) {
        await pool.query("DELETE FROM apply_attempts WHERE attempt_id = $1", [
          attemptId,
        ]);
      }
      // creatorUsername was deleted in the test body; cleanup is
      // best-effort in case the test bailed before the delete.
      await pool.query("DELETE FROM accounts WHERE username = $1", [
        creatorUsername,
      ]);
    }
  });
});
