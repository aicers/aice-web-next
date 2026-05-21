/**
 * Route-level coverage for `POST /api/aimer/analyze-envelope` (#629).
 *
 * The route is the single aice-web-next-side authority for minting the
 * four-field analyze-bridge envelope. Helper-level tests in
 * `src/__tests__/lib/aimer/analyze-envelope.test.ts` cover hashing,
 * JWS signing, and the REview canon mapper in isolation; this file
 * exercises the wiring that actually ships per call — setup gating,
 * tenant scope, baseline-vs-REview source selection, the Phase 2
 * enrichment strip, cross-token bindings (`context_jti`,
 * `payload_hash`, `envelope_hash`), target URL composition, and the
 * `aimer_analyze_envelope.issued` / `.denied` audit emissions.
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
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

// Pass GraphQL errors through untouched — the helper only rethrows
// `Review*` errors in their typed form, and the route already imports
// `ReviewForbiddenError` directly.
vi.mock("@/lib/node/error-mapping", () => ({
  withManagerErrorMapping: <T>(p: Promise<T>) => p,
}));

const mockLoadSingleBaseline = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/baseline-push", () => ({
  loadSingleBaselineEventWireItem: mockLoadSingleBaseline,
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

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: () => "127.0.0.1",
}));

const tmpDir = path.join(__dirname, ".tmp-aimer-analyze-envelope-route");
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

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/aimer/analyze-envelope", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeContext() {
  return { params: Promise.resolve({}) };
}

function reviewEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      __typename: "DnsCovertChannel",
      id: "12345",
      time: "2026-05-21T00:00:00Z",
      sensor: "sensor-1",
      origAddr: "10.0.0.1",
      origPort: 53,
      respAddr: "8.8.8.8",
      respPort: 53,
      proto: 17,
      host: null,
      query: "covert.example.com",
      uri: null,
      category: "DNS",
      confidence: 0.9,
      level: "HIGH",
      triageScores: [],
      ...overrides,
    },
  };
}

function baselineWireItem(): Record<string, unknown> {
  // Mirrors every field `loadSingleBaselineEventWireItem` actually
  // emits (see `buildStreamingEvent` in baseline-push.ts): canonical
  // event columns + `raw_event`, plus the corpus/baseline metadata
  // (`baseline_version`, `exclusions_fp`, `raw_score`,
  // `selector_tags`) and the four Phase 2 enrichment fields — all of
  // which the route's analyze-bridge projection must strip.
  return {
    event_key: "12345",
    event_time: "2026-05-21T00:00:00Z",
    kind: "DnsCovertChannel",
    sensor: "sensor-1",
    orig_addr: "10.0.0.1",
    orig_port: 53,
    resp_addr: "8.8.8.8",
    resp_port: 53,
    proto: 17,
    host: null,
    dns_query: "covert.example.com",
    uri: null,
    category: "DNS",
    baseline_version: "2026-05-01",
    exclusions_fp: "fp-abc",
    raw_score: 0.91,
    selector_tags: ["selector:a", "selector:b"],
    raw_event: {
      event_key: "12345",
      event_time: "2026-05-21T00:00:00Z",
      kind: "DnsCovertChannel",
      sensor: "sensor-1",
      orig_addr: "10.0.0.1",
      orig_port: 53,
      resp_addr: "8.8.8.8",
      resp_port: 53,
      proto: 17,
      host: null,
      dns_query: "covert.example.com",
      uri: null,
      category: "DNS",
    },
    window_signals: { s1_percentile_rank: 0.42 },
    score_window_context: { kind_cohort_size: 100 },
    asset_context: { primary_asset: "asset-A" },
    scoring_weights_snapshot: { s1: 1, s3: 1, s4: 1 },
  };
}

const SETUP_OK = {
  aiceId: "aice.example.com",
  bridgeUrl: "https://aimer.example.com",
  defaultModelName: "anthropic",
  defaultModel: "claude-sonnet-4-6",
  hasActiveSigningKey: true,
};

describe("POST /api/aimer/analyze-envelope", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";

    signingKey = await import("@/lib/aimer/signing-key");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();

    currentSession = makeSession();

    mockGetSetup.mockReset().mockResolvedValue({ ...SETUP_OK });
    mockHasPermission.mockReset();
    mockHasPermission.mockImplementation(
      async (_roles, perm) => perm === "detection:read",
    );
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockQuery.mockReset().mockResolvedValue({
      rows: [{ id: 42, external_key: "acmecorp.com" }],
      rowCount: 1,
    });
    mockGraphqlRequest.mockReset().mockResolvedValue(reviewEvent());
    mockLoadSingleBaseline.mockReset().mockResolvedValue(null);
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockRateLimit.mockReset().mockResolvedValue({ limited: false });
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Happy path: REview source ─────────────────────────────

  it("mints all four signed fields, target URL, and emits an issued audit row", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "KOREAN",
      }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.targetUrl).toBe(
      "https://aimer.example.com/api/analysis/analyze-bridge",
    );
    expect(typeof body.contextToken).toBe("string");
    expect(typeof body.eventsEnvelope).toBe("string");
    expect(typeof body.analyzeParamsToken).toBe("string");
    expect(typeof body.eventsData).toBe("string");

    // Verify all three JWSes round-trip through jose.
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload: ctx } = await jwtVerify(body.contextToken, verifyKey, {
      issuer: "aice.example.com",
      audience: "aimer-web",
    });
    expect(ctx.aice_id).toBe("aice.example.com");
    expect(ctx.customer_ids).toEqual(["acmecorp.com"]);

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.issued",
        target: "customer",
        targetId: "42",
        customerId: 42,
        details: expect.objectContaining({
          customerId: 42,
          jti: ctx.jti,
          eventKey: "12345",
          lang: "KOREAN",
          force: false,
          kid: status.active.kid,
          baselineSource: false,
        }),
      }),
    );
  });

  it("cross-binds context_jti / payload_hash / envelope_hash across the three JWSes", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );

    const { payload: ctxPayload } = await jwtVerify(
      body.contextToken,
      verifyKey,
      { issuer: "aice.example.com", audience: "aimer-web" },
    );
    const { payload: envPayload } = await jwtVerify(
      body.eventsEnvelope,
      verifyKey,
      { issuer: "aice.example.com" },
    );
    const { payload: paramsPayload } = await jwtVerify(
      body.analyzeParamsToken,
      verifyKey,
      { issuer: "aice.example.com" },
    );

    // context_jti: events_envelope and analyze_params_token must both
    // reference the context_token's jti.
    expect(envPayload.context_jti).toBe(ctxPayload.jti);
    expect(paramsPayload.context_jti).toBe(ctxPayload.jti);

    // payload_hash: events_envelope.payload_hash ==
    // analyze_params_token.payload_hash == sha256(events_data).
    const { createHash } = await import("node:crypto");
    const expectedPayloadHash = createHash("sha256")
      .update(Buffer.from(body.eventsData, "utf8"))
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(envPayload.payload_hash).toBe(expectedPayloadHash);
    expect(paramsPayload.payload_hash).toBe(expectedPayloadHash);

    // envelope_hash: sha256 of the events_envelope JWS compact bytes.
    const expectedEnvelopeHash = createHash("sha256")
      .update(Buffer.from(body.eventsEnvelope, "utf8"))
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(paramsPayload.envelope_hash).toBe(expectedEnvelopeHash);

    // event_key matches the locator and the analyze_params claim.
    expect(paramsPayload.event_key).toBe("12345");
    const parsedEventData = JSON.parse(body.eventsData) as Record<
      string,
      unknown
    >;
    expect(parsedEventData.event_key).toBe("12345");
  });

  it("pins one signing key across all three sibling JWSes (no kid drift on mid-mint rotation)", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    const ctxHeader = decodeProtectedHeader(body.contextToken);
    const envHeader = decodeProtectedHeader(body.eventsEnvelope);
    const paramsHeader = decodeProtectedHeader(body.analyzeParamsToken);
    expect(ctxHeader.kid).toBeDefined();
    expect(envHeader.kid).toBe(ctxHeader.kid);
    expect(paramsHeader.kid).toBe(ctxHeader.kid);

    // Audit row records the same kid that the on-wire tokens carry.
    const issuedCall = mockAuditRecord.mock.calls.find(
      (c) =>
        (c[0] as { action?: string } | undefined)?.action ===
        "aimer_analyze_envelope.issued",
    );
    expect(
      (issuedCall?.[0] as { details?: { kid?: string } } | undefined)?.details
        ?.kid,
    ).toBe(ctxHeader.kid);
  });

  it("composes targetUrl as <bridgeUrl>/api/analysis/analyze-bridge", async () => {
    mockGetSetup.mockResolvedValue({
      ...SETUP_OK,
      bridgeUrl: "https://aimer.example.com",
    });
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    expect(body.targetUrl).toBe(
      "https://aimer.example.com/api/analysis/analyze-bridge",
    );
  });

  // ── Baseline-vs-REview source branching ──────────────────

  it("projects the baseline wire item to the analyze-bridge canon (canonical columns + raw_event) when the event passes baseline", async () => {
    mockLoadSingleBaseline.mockResolvedValue(baselineWireItem());
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    const eventData = JSON.parse(body.eventsData) as Record<string, unknown>;
    // The four Phase 2 enrichment fields must be removed.
    expect(eventData).not.toHaveProperty("window_signals");
    expect(eventData).not.toHaveProperty("score_window_context");
    expect(eventData).not.toHaveProperty("asset_context");
    expect(eventData).not.toHaveProperty("scoring_weights_snapshot");
    // The corpus/baseline metadata the helper also emits must
    // not leak into the signed bridge payload.
    expect(eventData).not.toHaveProperty("baseline_version");
    expect(eventData).not.toHaveProperty("exclusions_fp");
    expect(eventData).not.toHaveProperty("raw_score");
    expect(eventData).not.toHaveProperty("selector_tags");
    // The projection is an exact allowlist — no surprise keys.
    expect(Object.keys(eventData).sort()).toEqual(
      [
        "category",
        "dns_query",
        "event_key",
        "event_time",
        "host",
        "kind",
        "orig_addr",
        "orig_port",
        "proto",
        "raw_event",
        "resp_addr",
        "resp_port",
        "sensor",
        "uri",
      ].sort(),
    );
    // Baseline-source columns are preserved.
    expect(eventData.event_key).toBe("12345");
    expect(eventData.kind).toBe("DnsCovertChannel");
    expect((eventData.raw_event as Record<string, unknown>).event_key).toBe(
      "12345",
    );

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.issued",
        details: expect.objectContaining({ baselineSource: true }),
      }),
    );
  });

  it("falls back to the REview canon (snake_case, with aliases) when no baseline row exists", async () => {
    // No baseline match — REview event drives event_data.
    mockLoadSingleBaseline.mockResolvedValue(null);
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    const eventData = JSON.parse(body.eventsData) as Record<string, unknown>;
    // Mapper aliases applied.
    expect(eventData.event_time).toBe("2026-05-21T00:00:00Z");
    expect(eventData.dns_query).toBe("covert.example.com");
    expect(eventData.kind).toBe("DnsCovertChannel");
    // UI-only fields are dropped.
    expect(eventData).not.toHaveProperty("confidence");
    expect(eventData).not.toHaveProperty("level");
    expect(eventData).not.toHaveProperty("triage_scores");
    // event_key pinned to the locator.
    expect(eventData.event_key).toBe("12345");

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.issued",
        details: expect.objectContaining({ baselineSource: false }),
      }),
    );
  });

  // ── Setup gating ─────────────────────────────────────────

  it.each([
    ["missing aiceId", { ...SETUP_OK, aiceId: null }],
    ["missing bridgeUrl", { ...SETUP_OK, bridgeUrl: null }],
    ["missing defaultModelName", { ...SETUP_OK, defaultModelName: null }],
    ["missing defaultModel", { ...SETUP_OK, defaultModel: null }],
    ["missing active signing key", { ...SETUP_OK, hasActiveSigningKey: false }],
  ])("returns 503 aimer_integration_not_configured when %s", async (_label, setup) => {
    mockGetSetup.mockResolvedValue(setup);
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("aimer_integration_not_configured");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({
          reason: "aimer_integration_not_configured",
        }),
      }),
    );
  });

  // ── Tenant scope ─────────────────────────────────────────

  it("returns 404 (existence mask) when caller lacks access to the requested customerId", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({ reason: "not_found" }),
      }),
    );
  });

  it("forces single-customer dispatch into REview even when the caller has wider scope", async () => {
    mockResolveScope.mockResolvedValue([42, 99]);
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const dispatchContext = mockGraphqlRequest.mock.calls[0][2];
    expect(dispatchContext.customerIds).toEqual([42]);
  });

  // ── REview scope failures ────────────────────────────────

  it("masks ReviewForbiddenError as 404 event_not_found_for_customer", async () => {
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockGraphqlRequest.mockRejectedValue(new ReviewForbiddenError("forbidden"));
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found_for_customer");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({
          reason: "event_not_found_for_customer",
        }),
      }),
    );
  });

  it("returns 404 event_not_found_for_customer when REview resolves to null", async () => {
    mockGraphqlRequest.mockResolvedValue({ event: null });
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("event_not_found_for_customer");
  });

  it("propagates operational graphql errors instead of masking as 404", async () => {
    mockGraphqlRequest.mockRejectedValue(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    await expect(
      POST(
        makeRequest({
          customerId: 42,
          locator: { id: "12345" },
          lang: "ENGLISH",
        }),
        makeContext(),
      ),
    ).rejects.toBeDefined();
    const issuedCalls = mockAuditRecord.mock.calls.filter(
      (c) =>
        (c[0] as { action?: string } | undefined)?.action ===
        "aimer_analyze_envelope.issued",
    );
    expect(issuedCalls).toEqual([]);
  });

  // ── external_key / customer resolution ───────────────────

  it("returns 400 customer_external_key_missing when external_key is NULL", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 42, external_key: null }],
      rowCount: 1,
    });
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("customer_external_key_missing");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({
          reason: "customer_external_key_missing",
        }),
      }),
    );
  });

  // ── Body / locator / lang validation ─────────────────────

  it("returns 400 invalid_event_key when locator.id is not a 1..39-digit decimal", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "abc" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_event_key");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({ reason: "invalid_event_key" }),
      }),
    );
  });

  it("returns 400 invalid_lang when lang is not ENGLISH/KOREAN", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({ customerId: 42, locator: { id: "12345" }, lang: "fr" }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_lang");
  });

  it("returns 400 invalid_customer_id when customerId is not a positive integer", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: "42",
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_customer_id");
  });

  it("threads force=true into analyze_params_token and the audit row", async () => {
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
        force: true,
      }),
      makeContext(),
    );
    const body = (await res.json()) as Record<string, string>;
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(body.analyzeParamsToken, verifyKey, {
      issuer: "aice.example.com",
    });
    expect(payload.force).toBe(true);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.issued",
        details: expect.objectContaining({ force: true }),
      }),
    );
  });

  // ── Rate limit ───────────────────────────────────────────

  it("returns 429 rate_limited with Retry-After when the bridge bucket is exhausted", async () => {
    mockRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 30 });
    const { POST } = await import("@/app/api/aimer/analyze-envelope/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        locator: { id: "12345" },
        lang: "ENGLISH",
      }),
      makeContext(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_analyze_envelope.denied",
        details: expect.objectContaining({ reason: "rate_limited" }),
      }),
    );
  });
});
