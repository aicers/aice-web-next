import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

// ── Mock guard so we control the session shape directly ──────

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: (handler: HandlerFn) => async (req: NextRequest, ctx: unknown) =>
    handler(req, ctx, currentSession),
}));

const mockHasPermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockBuildPush = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/orchestrate", () => ({
  buildPhase2Push: mockBuildPush,
}));

const mockState = vi.hoisted(() => ({
  claimPendingNotices: vi.fn(),
  insertInflight: vi.fn(),
  commitOnAck: vi.fn(),
  recordOnFail: vi.fn(),
  pruneExpiredInflight: vi.fn(),
}));
vi.mock("@/lib/aimer/phase2/state", () => mockState);

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

// ── Helpers ───────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Tenant Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Mozilla/5.0",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "http://localhost/api/aimer/phase2/policy-event/next-batch",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const ctx = { params: Promise.resolve({}) };

// ── Suite ─────────────────────────────────────────────────────

describe("POST /api/aimer/phase2/policy-event/next-batch", () => {
  beforeEach(() => {
    currentSession = makeSession();

    mockHasPermission.mockReset().mockImplementation(async (_roles, perm) => {
      // Default: not an admin (no customers:access-all) so the scope
      // gate runs; permits triage:read for the route's guard.
      if (perm === "customers:access-all") return false;
      return true;
    });
    mockResolveScope.mockReset().mockResolvedValue([42]);

    mockBuildPush.mockReset().mockResolvedValue({
      context_token: "ctx-jws",
      events_envelope: "env-jws",
      events_data: '{"withdrawals":[]}',
      context_jti: "jti-new",
    });

    mockState.claimPendingNotices.mockReset().mockResolvedValue([]);
    mockState.insertInflight.mockReset().mockResolvedValue(undefined);
    mockState.commitOnAck.mockReset().mockResolvedValue(undefined);
    mockState.recordOnFail.mockReset().mockResolvedValue(undefined);
    mockState.pruneExpiredInflight.mockReset().mockResolvedValue(0);

    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
  });

  // ── Body validation ─────────────────────────────────────────

  it("rejects requests with both acked_context_jti and failed_context_jti", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        acked_context_jti: "jti-a",
        failed_context_jti: "jti-b",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "mutually_exclusive_ack_and_fail",
    });
  });

  it("returns 400 on invalid customerId", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: "nope" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the caller cannot access the requested customer", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    expect(res.status).toBe(404);
  });

  // ── Ack / fail flow ─────────────────────────────────────────

  it("calls commitOnAck when acked_context_jti is supplied", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    await POST(
      makeRequest({ customerId: 42, acked_context_jti: "jti-prev" }),
      ctx,
    );
    // The route MUST scope the inflight lookup to its own kind
    // ("policy_event") so a JTI minted by a baseline/story drain
    // cannot accidentally advance `aimer_push_state` through this
    // queue-only route.
    expect(mockState.commitOnAck).toHaveBeenCalledWith(
      42,
      "jti-prev",
      "policy_event",
    );
    expect(mockState.recordOnFail).not.toHaveBeenCalled();
  });

  it("calls recordOnFail when failed_context_jti is supplied", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    await POST(
      makeRequest({
        customerId: 42,
        failed_context_jti: "jti-prev",
        failure_reason: "aimer 500",
      }),
      ctx,
    );
    // Same kind-scoping requirement as ack: a failure report through
    // this queue-only route must not write
    // `aimer_push_state.last_error` for a streaming kind.
    expect(mockState.recordOnFail).toHaveBeenCalledWith(
      42,
      "jti-prev",
      "aimer 500",
      "policy_event",
    );
    expect(mockState.commitOnAck).not.toHaveBeenCalled();
  });

  // ── Empty queue ─────────────────────────────────────────────

  it("returns has_more=false with null components when the queue is empty", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      has_more: false,
      context_token: null,
      events_envelope: null,
      events_data: null,
      context_jti: null,
      aimer_endpoint_path: null,
      aimer_endpoint_url: null,
      batch_jti: null,
      schema_version: null,
    });
    expect(mockBuildPush).not.toHaveBeenCalled();
    expect(mockState.insertInflight).not.toHaveBeenCalled();
  });

  // ── Non-empty queue → mint envelope + inflight ──────────────

  it("signs withdraw envelope and inserts inflight when queue has rows", async () => {
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_policy_event",
        payload: {
          kind: "policy_event",
          run_id: "9",
          event_keys: ["100", "101"],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
      {
        id: "2",
        enqueued_at: new Date(),
        kind: "withdraw_policy_event",
        payload: {
          kind: "policy_event",
          run_id: "9",
          event_keys: ["102"],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);

    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    expect(res.status).toBe(200);

    // buildPhase2Push receives schema_version + the assembled withdraw
    // payload + the real session account_id as the `sub` claim source.
    expect(mockBuildPush).toHaveBeenCalledTimes(1);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.schemaVersion).toBe("phase2.withdraw.v1");
    expect(args.customerId).toBe(42);
    expect(args.accountId).toBe("account-1");
    expect(args.payload.withdrawals).toHaveLength(2);

    expect(mockState.insertInflight).toHaveBeenCalledWith(42, {
      contextJti: "jti-new",
      kind: "policy_event",
      cursorAdvanceToEventTime: null,
      cursorAdvanceToEventKey: null,
      queueRowIds: ["1", "2"],
    });

    const body = await res.json();
    expect(body.has_more).toBe(false);
    expect(body.context_token).toBe("ctx-jws");
    expect(body.events_envelope).toBe("env-jws");
    expect(body.events_data).toBe('{"withdrawals":[]}');
    expect(body.context_jti).toBe("jti-new");
    expect(body.batch_jti).toBe("jti-new");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/withdraw");
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/withdraw",
    );
    expect(body.schema_version).toBe("phase2.withdraw.v1");
  });

  it("composes aimer_endpoint_url from bridgeUrl + path, handling trailing slash", async () => {
    mockGetSetup.mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com/",
      hasActiveSigningKey: true,
    });
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_policy_event",
        payload: { kind: "policy_event", run_id: "9", event_keys: ["100"] },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/withdraw",
    );
    expect(body.aimer_endpoint_url.endsWith("/api/phase2/withdraw")).toBe(true);
  });

  it("sets has_more=true when more rows remain past the batch limit", async () => {
    // 101 rows → claim returns max+1 → has_more must be true.
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: String(i + 1),
      enqueued_at: new Date(),
      kind: "withdraw_policy_event",
      payload: { kind: "policy_event", run_id: "9", event_keys: ["100"] },
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      acked_at: null,
      acked_context_jti: null,
    }));
    mockState.claimPendingNotices.mockResolvedValue(rows);

    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.has_more).toBe(true);

    // The inflight row receives only the first MAX_BATCH_SIZE ids.
    const insertArgs = mockState.insertInflight.mock.calls[0][1];
    expect(insertArgs.queueRowIds).toHaveLength(100);
  });

  // ── TTL prune ───────────────────────────────────────────────

  it("opportunistically prunes expired inflight rows on every call", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockState.pruneExpiredInflight).toHaveBeenCalledWith(42);
  });

  // ── Attribution ─────────────────────────────────────────────

  it("threads the real session account_id (not SYSTEM_ACTOR) into buildPhase2Push", async () => {
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_policy_event",
        payload: {
          kind: "policy_event",
          run_id: "9",
          event_keys: ["100"],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    currentSession = makeSession({ accountId: "real-account-uuid" });

    const { POST } = await import(
      "@/app/api/aimer/phase2/policy-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockBuildPush.mock.calls[0][0].accountId).toBe("real-account-uuid");
  });
});
