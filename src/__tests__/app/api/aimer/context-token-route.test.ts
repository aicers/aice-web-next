import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockHasPermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

const mockGraphqlRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

const mockAuditRecord = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const mockRateLimit = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ limited: false }),
);
vi.mock("@/lib/rate-limit/limiter", () => ({
  checkAimerContextTokenRateLimit: mockRateLimit,
}));

const tmpDir = path.join(__dirname, ".tmp-aimer-context-token-route");
const dataDir = path.join(tmpDir, "data");

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

function makeLocator(overrides: Record<string, unknown> = {}) {
  return {
    sensor: "sensor-1",
    time: "2024-01-01T00:00:00Z",
    origAddr: "10.0.0.1",
    origPort: 1234,
    respAddr: "10.0.0.2",
    respPort: 80,
    proto: 6,
    kind: "HttpThreat",
    level: "HIGH",
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/aimer/context-token", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeContext() {
  return { params: Promise.resolve({}) };
}

function eventDetailNodes(n = 1) {
  return {
    eventList: {
      totalCount: String(n),
      nodes: Array.from({ length: n }, (_, i) => ({
        __typename: "HttpThreat",
        time: "2024-01-01T00:00:00Z",
        sensor: "sensor-1",
        confidence: 0,
        category: "RECONNAISSANCE",
        level: "HIGH",
        triageScores: [],
        index: i,
      })),
      edges: [],
      pageInfo: {
        hasPreviousPage: false,
        hasNextPage: false,
        startCursor: null,
        endCursor: null,
      },
    },
  };
}

describe("POST /api/aimer/context-token", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";

    signingKey = await import("@/lib/aimer/signing-key");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();

    currentSession = makeSession();

    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    mockHasPermission.mockReset();
    mockHasPermission.mockImplementation(
      async (_roles, perm) => perm === "detection:read",
    );
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockQuery.mockReset().mockResolvedValue({
      rows: [{ id: 42, external_key: "acmecorp.com" }],
      rowCount: 1,
    });
    mockGraphqlRequest.mockReset().mockResolvedValue(eventDetailNodes(1));
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockRateLimit.mockReset().mockResolvedValue({ limited: false });
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Happy path ────────────────────────────────────────────

  it("issues signed JWS values, target URL, and stub events JSON", async () => {
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.targetUrl).toBe("https://aimer.example.com/api/auth/bridge");
    expect(body.eventsDataJson).toBe(
      '{"hello":"world","schema_version":"0.0-stub","event_count":1}',
    );
    expect(typeof body.contextTokenJws).toBe("string");
    expect(typeof body.eventsEnvelopeJws).toBe("string");

    // Verify JWS shape with the active public key.
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );

    const ctxJws = body.contextTokenJws as string;
    const ctxHeader = decodeProtectedHeader(ctxJws);
    expect(ctxHeader.kid).toBe(status.active.kid);
    const { payload: ctxPayload } = await jwtVerify(ctxJws, verifyKey, {
      issuer: "aice.example.com",
      audience: "aimer-web",
    });
    expect(ctxPayload.aice_id).toBe("aice.example.com");
    expect(ctxPayload.customer_ids).toEqual(["acmecorp.com"]);
    expect(ctxPayload.sub).toBe("account-1");
    expect((ctxPayload.exp ?? 0) - (ctxPayload.iat ?? 0)).toBe(60);
    expect(typeof ctxPayload.jti).toBe("string");

    // Verify envelope shape and binding to the context token.
    const envJws = body.eventsEnvelopeJws as string;
    const { payload: envPayload } = await jwtVerify(envJws, verifyKey, {
      issuer: "aice.example.com",
    });
    expect(envPayload.context_jti).toBe(ctxPayload.jti);
    expect(envPayload.customer_ids).toEqual(["acmecorp.com"]);
    expect(envPayload.schema_version).toBe("0.0-stub");
    expect(envPayload.event_count).toBe(1);
    expect(envPayload.exp).toBe(ctxPayload.exp);
    expect(envPayload.iat).toBe(ctxPayload.iat);
    expect(typeof envPayload.payload_hash).toBe("string");

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.issued",
        target: "customer",
        targetId: "42",
        customerId: 42,
        details: expect.objectContaining({
          customerId: 42,
          jti: ctxPayload.jti,
          kid: status.active.kid,
        }),
      }),
    );
  });

  it("forces single-customer dispatch — never relies on session full scope", async () => {
    // Caller has access to two customers, asks for #42 only.
    mockResolveScope.mockResolvedValue([42, 99]);

    const { POST } = await import("@/app/api/aimer/context-token/route");
    await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockGraphqlRequest.mock.calls[0];
    const dispatchContext = callArgs[2];
    expect(dispatchContext.customerIds).toEqual([42]);
  });

  // ── Setup gating (Sub-7.2.AB) ────────────────────────────

  it.each([
    [{ aiceId: null, bridgeUrl: "https://x", hasActiveSigningKey: true }],
    [{ aiceId: "aice", bridgeUrl: null, hasActiveSigningKey: true }],
    [{ aiceId: "aice", bridgeUrl: "https://x", hasActiveSigningKey: false }],
  ])("returns 503 aimer_integration_not_configured when setup is incomplete", async (setup) => {
    mockGetSetup.mockResolvedValue(setup);
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("aimer_integration_not_configured");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.denied",
        details: expect.objectContaining({
          reason: "aimer_integration_not_configured",
        }),
      }),
    );
  });

  // ── Customer access — 404 mask ─────────────────────────────

  it("returns 404 event_not_found_for_customer when caller lacks access to customerId", async () => {
    // Caller is scoped to customer 99 only; requests 42.
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found_for_customer");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.denied",
        details: expect.objectContaining({
          reason: "event_not_found_for_customer",
        }),
      }),
    );
  });

  it("returns 404 (NOT 403) — same shape as locator-mismatch — to avoid leaking existence", async () => {
    // Locator resolves to no events under the chosen customer.
    mockGraphqlRequest.mockResolvedValue(eventDetailNodes(0));
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found_for_customer");
    // Token must NOT be issued in this case.
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.denied",
        details: expect.objectContaining({
          reason: "event_not_found_for_customer",
        }),
      }),
    );
    expect(mockAuditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "aimer_context_token.issued" }),
    );
  });

  // ── external_key gating (#438) ─────────────────────────────

  it("returns 400 customer_external_key_missing when external_key is NULL", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 42, external_key: null }],
      rowCount: 1,
    });
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("customer_external_key_missing");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.denied",
        details: expect.objectContaining({
          reason: "customer_external_key_missing",
        }),
      }),
    );
  });

  // ── Rate limit ─────────────────────────────────────────────

  it("returns 429 with rate_limited audit reason on bridge bucket exhaustion", async () => {
    mockRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 30 });
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_context_token.denied",
        details: expect.objectContaining({ reason: "rate_limited" }),
      }),
    );
  });

  // ── Body validation ────────────────────────────────────────

  it("returns 400 invalid_locator when locator fails the strict validator", async () => {
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: makeLocator({ kind: "NotARealKind" }),
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_locator");
  });

  it("returns 400 invalid_customer_id when customerId is missing or not a positive integer", async () => {
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: "42", locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_customer_id");
  });

  // ── customers:access-all path ─────────────────────────────

  it("admin with customers:access-all bypasses per-account scope but still forces single-customer dispatch", async () => {
    mockHasPermission.mockImplementation(
      async (_roles, perm) =>
        perm === "detection:read" || perm === "customers:access-all",
    );
    // resolveEffectiveCustomerIds is not consulted on this path — but
    // the customers SELECT must still find the row.
    mockResolveScope.mockResolvedValue([]);
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const callArgs = mockGraphqlRequest.mock.calls[0];
    expect(callArgs[2].customerIds).toEqual([42]);
  });

  it("admin with non-existent customer still gets 404 mask (no existence leak)", async () => {
    mockHasPermission.mockImplementation(
      async (_roles, perm) =>
        perm === "detection:read" || perm === "customers:access-all",
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 999, locator: makeLocator() }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found_for_customer");
  });

  // ── JWS-consumer compatibility — claim shape ──────────────

  it("context-token jti is also visible to the legacy decodeJwt() consumer", async () => {
    const { POST } = await import("@/app/api/aimer/context-token/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: makeLocator() }),
      makeContext(),
    );
    const { contextTokenJws } = (await res.json()) as {
      contextTokenJws: string;
    };
    const claims = decodeJwt(contextTokenJws);
    expect(claims.iss).toBe("aice.example.com");
    expect(claims.aud).toBe("aimer-web");
    expect(typeof claims.jti).toBe("string");
  });
});
