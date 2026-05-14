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
  APPLY_ATTEMPT_TTL_MS_DEFAULT,
  type PlannedDispatch,
} from "@/lib/node/apply-attempt-types";

/**
 * DB-backed integration test for `createApplyAttempt` (#359).
 *
 * Round 2 review asked for end-to-end coverage that exercises the real
 * `bytea` + `jsonb` insert path and reads the persisted row back, so
 * a serialization / parameter-order regression in the SQL call cannot
 * pass with a fully mocked `query`. Only the manager GraphQL transport
 * (`@/lib/graphql/client`) is mocked here — every other dependency
 * (permissions read from `roles` / `role_permissions`, customer scope
 * resolution, the INSERT itself, and the read-back) hits the real DB.
 */

const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockBuildExternalConfigSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

// Comparison-based plan-build (#551 / Decision 9) reads each
// non-delete-intent external's endpoint `config` to decide whether to
// emit the external dispatch. The integration suite intentionally
// only mocks the manager GraphQL transport — Giganto / Tivan would
// not be reachable here, so we mock the snapshot builder to emulate
// the change-intent path (applied side absent ⇒ emit dispatch). The
// other DB-backed write paths still hit the real Postgres.
vi.mock("@/lib/node/external-config-snapshot", () => ({
  buildExternalConfigSnapshot: mockBuildExternalConfigSnapshot,
  externalKindsOnNode: vi.fn(),
  externalKindsOnNodes: vi.fn(),
}));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/auth_db";

let pool: pg.Pool;
let testActorId: string;
const testUsername = `create-apply-attempt-test-${randomUUID()}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  // Seed a real System Administrator account so the FK reference holds
  // and `nodes:write` / `services:write` resolve from `role_permissions`.
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
  mockGetCurrentSession.mockReset();
  mockGetCurrentSession.mockResolvedValue(makeSession());
  mockBuildExternalConfigSnapshot.mockReset();
  // Default: empty snapshot — externals on non-delete-intent rows
  // hit the change-intent branch of the plan builder and get a
  // dispatch row each. Individual tests override to exercise the
  // steady-state / unavailable paths.
  mockBuildExternalConfigSnapshot.mockResolvedValue({});
});

function makeSession(): AuthSession {
  return {
    accountId: testActorId,
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

interface PersistedRow {
  status: string;
  executing_lock: string | null;
  claim_started_at: Date | null;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  draft_fingerprint: Buffer;
  planned_dispatches: PlannedDispatch[];
  node_id: string;
}

async function readRow(attemptId: string): Promise<PersistedRow> {
  const { rows } = await pool.query<PersistedRow>(
    `SELECT status, executing_lock, claim_started_at, created_by,
            created_at, expires_at, draft_fingerprint, planned_dispatches,
            node_id
     FROM apply_attempts WHERE attempt_id = $1`,
    [attemptId],
  );
  return rows[0];
}

describe("createApplyAttempt — DB-backed insert + read-back", () => {
  it("persists status=pending, NULL lock, created_by, TTL, fingerprint, and per-dispatch JSON shape", async () => {
    mockGraphqlRequest.mockResolvedValue({
      node: {
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
            draft: "{cfg:1}",
          },
          {
            kind: "TI_CONTAINER",
            key: "k2",
            status: "ENABLED",
            draft: "{cfg:2}",
          },
          // No-draft service is excluded from the plan.
          { kind: "DATA_STORE", key: "k3", status: "ENABLED", draft: null },
        ],
      },
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({
      nodeId: "node-1",
    });

    // Read the row back and assert against the actually-persisted state.
    const row = await readRow(result.attemptId);

    expect(row.status).toBe("pending");
    expect(row.executing_lock).toBeNull();
    expect(row.claim_started_at).toBeNull();
    expect(row.created_by).toBe(testActorId);
    expect(row.node_id).toBe("node-1");

    // TTL: expires_at - created_at is the configured TTL (default 30m).
    const ttlMs = row.expires_at.getTime() - row.created_at.getTime();
    expect(Math.abs(ttlMs - APPLY_ATTEMPT_TTL_MS_DEFAULT)).toBeLessThan(1000);

    // Returned `expiresAt` matches the persisted timestamp.
    expect(new Date(result.expiresAt).getTime()).toBe(row.expires_at.getTime());

    // Persisted `bytea` fingerprint round-trips to the returned lower-case
    // hex string. This catches a serialization / parameter-order regression
    // that a mocked `query` would let through.
    expect(row.draft_fingerprint).toBeInstanceOf(Buffer);
    expect(row.draft_fingerprint.length).toBe(32);
    expect(row.draft_fingerprint.toString("hex")).toBe(result.draftFingerprint);

    // Per-dispatch JSON shape: 2 manager rows (DB + notify, neither
    // carries `new`) + 2 external (frozen `new`). The no-draft external
    // service is excluded. Phase Node-12 (#333) split the v1 single
    // `MANAGER` dispatch into `MANAGER_DB` (atomic `applyNodeDraft`
    // write) and `MANAGER_NOTIFY` (`applyAgentConfig` agent notify) so
    // each stage is independently observable and retryable.
    expect(row.planned_dispatches).toHaveLength(4);
    const [managerDb, managerNotify, ext1, ext2] = row.planned_dispatches;

    expect(managerDb.kind).toBe("MANAGER_DB");
    expect(managerDb.state).toBe("queued");
    expect(managerDb.attemptCount).toBe(0);
    expect(managerDb.lastError).toBeNull();
    expect("new" in managerDb).toBe(false);

    expect(managerNotify.kind).toBe("MANAGER_NOTIFY");
    expect(managerNotify.state).toBe("queued");
    expect(managerNotify.attemptCount).toBe(0);
    expect(managerNotify.lastError).toBeNull();
    expect("new" in managerNotify).toBe(false);

    expect(ext1.kind).toBe("DATA_STORE");
    expect(ext1.state).toBe("queued");
    expect(ext1.attemptCount).toBe(0);
    expect(ext1.lastError).toBeNull();
    if (ext1.kind === "DATA_STORE" || ext1.kind === "TI_CONTAINER") {
      expect(ext1.new).toBe("{cfg:1}");
    }

    expect(ext2.kind).toBe("TI_CONTAINER");
    expect(ext2.state).toBe("queued");
    if (ext2.kind === "DATA_STORE" || ext2.kind === "TI_CONTAINER") {
      expect(ext2.new).toBe("{cfg:2}");
    }
  });
});
