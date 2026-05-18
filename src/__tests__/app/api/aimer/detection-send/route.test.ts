/**
 * Coverage for `POST /api/aimer/detection-send` — the routing endpoint
 * added in sub-issue #621.
 *
 * Verifies the routing rule that splits the Detection menu Send button
 * between Phase 1 and Phase 2:
 *   - Baseline-passing event → Phase 2 multipart envelope returned in
 *     the same response (one round-trip).
 *   - Non-baseline-passing event → `{ route: "phase1" }` so the client
 *     falls back to the existing `/api/aimer/context-token` flow.
 *   - Cross-tenant access (a `detection:read` user for tenant A asking
 *     about tenant B) is masked as 404 so existence is not leaked.
 *
 * The route writes no rows in `aimer_push_state` /
 * `aimer_push_inflight` / `aimer_push_queue` — single-event manual
 * Send must not advance the streaming cursor (RFC 0002 §8). The tests
 * therefore mock the loader + orchestration helpers and assert on the
 * response shape; no DB-side state assertions are required here.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

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
  SYSTEM_ACTOR_ACCOUNT_ID: "00000000-0000-0000-0000-000000000000",
}));

const mockLoadSingle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/baseline-push", () => ({
  loadSingleBaselineEventWireItem: mockLoadSingle,
}));

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockCheckRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit/limiter", () => ({
  checkAimerContextTokenRateLimit: mockCheckRateLimit,
}));

const mockAuditRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const mockGraphqlRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

// `withManagerErrorMapping` is a thin wrapper that rethrows `Review*`
// errors in their typed form; for routing-decision tests we pass the
// promise through untouched and rely on the `graphqlRequest` mock to
// either resolve a hit / null or throw a `ReviewForbiddenError`.
vi.mock("@/lib/node/error-mapping", () => ({
  withManagerErrorMapping: <T>(p: Promise<T>) => p,
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: () => "127.0.0.1",
}));

const now = Math.floor(Date.now() / 1000);
function makeSession(): AuthSession {
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
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/aimer/detection-send", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

function makeWireItem() {
  // Minimal shape — the helper produces a full {@link
  // BaselineStreamingEvent}, but the route only forwards
  // `baseline_version` + the row into `buildPhase2Push`'s payload, and
  // the orchestrator is mocked. Keep the shape lean so the tests do
  // not couple to enrichment internals.
  return {
    event_key: "100",
    event_time: "2026-01-15T00:00:00.000Z",
    kind: "HttpThreat",
    sensor: "s1",
    orig_addr: "10.0.0.1",
    orig_port: 12345,
    resp_addr: "10.0.0.2",
    resp_port: 80,
    proto: 6,
    host: "example.com",
    dns_query: null,
    uri: "/path",
    category: "reconnaissance",
    baseline_version: "phase1b-four-selector",
    exclusions_fp: "fp",
    raw_score: 0.7,
    selector_tags: [],
    raw_event: {},
    score_window_context: {
      kind_cohort_window: { from: "a", to: "b" },
      kind_cohort_size: 1,
      baseline_rank_snapshot: 0.5,
    },
    window_signals: {
      s1_percentile_rank: null,
      s3_recurring_count: 0,
      s4_correlated_count: 0,
      s4_correlated_event_keys: [],
    },
    asset_context: {
      primary_asset: "10.0.0.1",
      peer_event_summary: { total_peer_count: 0, top_peer_kinds: [] },
    },
    scoring_weights_snapshot: {},
  };
}

describe("POST /api/aimer/detection-send", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockHasPermission.mockReset().mockImplementation(async (_r, p) => {
      if (p === "customers:access-all") return false;
      return true;
    });
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockBuildPush.mockReset().mockResolvedValue({
      context_token: "ctx-jws",
      events_envelope: "env-jws",
      events_data: '{"events":[]}',
      context_jti: "jti-detection-send",
    });
    mockLoadSingle.mockReset().mockResolvedValue(null);
    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    mockCheckRateLimit.mockReset().mockResolvedValue({ limited: false });
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    // Default REview event-resolution gate response: a non-null event
    // means the session can read it. Individual tests override this to
    // exercise the null / ReviewForbiddenError branches.
    mockGraphqlRequest.mockReset().mockResolvedValue({
      event: {
        __typename: "HttpThreat",
        id: "100",
        time: "2026-01-15T00:00:00Z",
        sensor: "s1",
        confidence: 0,
        category: "RECONNAISSANCE",
        level: "HIGH",
        triageScores: [],
      },
    });
  });

  it("routes to Phase 1 when the event is not baseline-passing", async () => {
    mockLoadSingle.mockResolvedValue(null);
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string };
    expect(body.route).toBe("phase1");
    // Orchestrator + setup are not consulted on the Phase 1 path — the
    // routing decision is the cheap probe.
    expect(mockBuildPush).not.toHaveBeenCalled();
    expect(mockGetSetup).not.toHaveBeenCalled();
  });

  it("routes to Phase 2 when the event is baseline-passing", async () => {
    mockLoadSingle.mockResolvedValue(makeWireItem());
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.route).toBe("phase2");
    expect(body.schema_version).toBe("phase2.baseline.v1");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/baseline/batch");
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/baseline/batch",
    );
    expect(body.context_token).toBe("ctx-jws");
    expect(body.context_jti).toBe("jti-detection-send");
    // The orchestrator is called with the single-event batch shape; the
    // payload's `baseline_version` comes from the loaded row so a
    // streaming-cursor sweep across a version bump cannot mix versions
    // into a manual Send.
    expect(mockBuildPush).toHaveBeenCalledTimes(1);
    const buildArg = mockBuildPush.mock.calls[0][0] as {
      schemaVersion: string;
      payload: { events: unknown[]; baseline_version: string };
    };
    expect(buildArg.schemaVersion).toBe("phase2.baseline.v1");
    expect(buildArg.payload.events).toHaveLength(1);
    expect(buildArg.payload.baseline_version).toBe("phase1b-four-selector");
    // Phase 2 issuance fires `aimer_detection_send.issued` with the
    // envelope's `jti` and the resolved customer scope, mirroring the
    // existing `aimer_context_token.issued` shape so the audit-log
    // viewer can correlate Phase 2 sends against the corresponding
    // aimer-web `(baseline_version, event_key)` ack.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const auditArg = mockAuditRecord.mock.calls[0][0] as {
      action: string;
      customerId: number;
      details: Record<string, unknown>;
    };
    expect(auditArg.action).toBe("aimer_detection_send.issued");
    expect(auditArg.customerId).toBe(42);
    expect(auditArg.details.jti).toBe("jti-detection-send");
    expect(auditArg.details.eventKey).toBe("100");
    expect(auditArg.details.baselineVersion).toBe("phase1b-four-selector");
  });

  it("does not audit on the Phase 1 routing decision — the downstream context-token route owns that emission", async () => {
    mockLoadSingle.mockResolvedValue(null);
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the bridge bucket is exhausted", async () => {
    mockCheckRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 30,
    });
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // Downstream surface is never consulted on the rate-limited path —
    // tenant-membership lookup and corpus probe are both skipped, so a
    // burst of clicks cannot use the rate-limit denial timing as an
    // existence oracle.
    expect(mockResolveScope).not.toHaveBeenCalled();
    expect(mockLoadSingle).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord.mock.calls[0][0].action).toBe(
      "aimer_detection_send.denied",
    );
    expect(mockAuditRecord.mock.calls[0][0].details.reason).toBe(
      "rate_limited",
    );
  });

  it("returns 404 (not_found) for cross-tenant access — existence is never leaked", async () => {
    mockResolveScope.mockResolvedValue([99]); // session lacks customer 42
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // Loader is never called — the access gate runs before the corpus
    // probe so tenant-B membership cannot be inferred from response
    // timing either.
    expect(mockLoadSingle).not.toHaveBeenCalled();
    // Cross-tenant denial audit row must NOT carry the requested
    // customerId — otherwise the audit log itself becomes a tenant-
    // membership oracle. Mirrors the `aimer_context_token.denied`
    // policy decision.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord.mock.calls[0][0].action).toBe(
      "aimer_detection_send.denied",
    );
    expect(mockAuditRecord.mock.calls[0][0].details.reason).toBe("not_found");
    expect(
      mockAuditRecord.mock.calls[0][0].details.requestedCustomerId,
    ).toBeUndefined();
  });

  it("rejects malformed locator with invalid_locator (400)", async () => {
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: 12345 }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_locator" });
  });

  it("rejects missing/invalid customerId with invalid_customer_id (400)", async () => {
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: -1 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_customer_id" });
  });

  it("masks a REview event-resolution miss as 404 event_not_found_for_customer — corpus presence is never leaked", async () => {
    // The central security property shared with the Phase 1 context-
    // token route (#439): a `detection:read` caller for tenant A must
    // not be able to mint a Phase 2 envelope for an event the session
    // cannot currently read in REview, even if that event happens to
    // exist in tenant A's `baseline_triaged_event` corpus. Returning
    // `{ route: "phase1" }` here would leak corpus presence to a
    // session that has no readability claim, so the route masks both
    // misses (the row is genuinely not in the corpus from REview's
    // perspective) and forbidden (the row exists but the session is
    // out of scope) as the same 404 shape — matching the Phase 1
    // route's masked-existence policy.
    mockGraphqlRequest.mockResolvedValue({ event: null });
    // Even if a baseline row is present, the gate must short-circuit
    // before the corpus probe so response timing cannot distinguish
    // "row absent" from "row present, session unauthorized".
    mockLoadSingle.mockResolvedValue(makeWireItem());
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "event_not_found_for_customer",
    });
    // Loader and orchestrator are never consulted — the gate runs
    // before either, so the corpus is not probed for an out-of-scope
    // event.
    expect(mockLoadSingle).not.toHaveBeenCalled();
    expect(mockBuildPush).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord.mock.calls[0][0].action).toBe(
      "aimer_detection_send.denied",
    );
    expect(mockAuditRecord.mock.calls[0][0].details.reason).toBe(
      "event_not_found_for_customer",
    );
  });

  it("masks a REview ForbiddenError as 404 event_not_found_for_customer", async () => {
    // REview signals "session has no scope for this event" with a
    // `ReviewForbiddenError`. We collapse it to the same masked 404
    // so existence is not leaked through a divergent status code.
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockGraphqlRequest.mockRejectedValue(new ReviewForbiddenError("forbidden"));
    mockLoadSingle.mockResolvedValue(makeWireItem());
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const res = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "event_not_found_for_customer",
    });
    expect(mockLoadSingle).not.toHaveBeenCalled();
    expect(mockBuildPush).not.toHaveBeenCalled();
  });

  it("dispatches the REview event(id:) lookup with a single-customer scope", async () => {
    // Regression guard for the #621 security property: the dispatch
    // context must carry exactly `[customerId]`, regardless of the
    // caller's full effective scope. A multi-customer user whose Send
    // click targets customer 42 must not have their dispatch widened
    // to `[42, 99, ...]` — that would let an event resolvable only
    // under customer 99 satisfy the gate while the envelope is
    // bound to customer 42.
    mockResolveScope.mockResolvedValue([42, 99]);
    mockLoadSingle.mockResolvedValue(makeWireItem());
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    await POST(makeRequest({ locator: { id: "100" }, customerId: 42 }), ctx);
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const [, vars, dispatchCtx] = mockGraphqlRequest.mock.calls[0];
    expect(vars).toEqual({ id: "100" });
    expect(dispatchCtx).toEqual({
      role: "Tenant Administrator",
      customerIds: [42],
    });
  });

  it("re-clicking the same baseline-passing event mints a fresh envelope and never advances the cursor", async () => {
    // Idempotency on re-click is enforced on aimer-web's
    // `(baseline_version, event_key)` check — the local route just
    // mints fresh tokens both times. The acceptance criteria
    // specifically calls out that the cursor is NOT advanced on the
    // manual single-event path (RFC 0002 §8 "Race vs cursor"), which
    // here means the route never invokes any `aimer_push_state` writer.
    // The mock surface intentionally does NOT include `commitOnAck` or
    // `insertInflight`, so a regression that started threading the
    // manual path through cursor advancement would surface as an
    // unmocked-module failure rather than a silent state corruption.
    mockLoadSingle.mockResolvedValue(makeWireItem());
    const { POST } = await import("@/app/api/aimer/detection-send/route");
    const first = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    const second = await POST(
      makeRequest({ locator: { id: "100" }, customerId: 42 }),
      ctx,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockBuildPush).toHaveBeenCalledTimes(2);
  });
});
