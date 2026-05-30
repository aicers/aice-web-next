/**
 * Tests for the Phase 2 LIVE / DAILY report summary routes (#646):
 * - `GET /api/aimer/analysis/reports/live/[customerId]/summary`
 * - `GET /api/aimer/analysis/reports/daily/[customerId]/[date]/summary`
 *
 * Both are thin wrappers over the shared
 * `resolveAnalysisSummaryResponse` helper, so these tests focus on what
 * the routes own: parameter parsing, the DAILY `[date]` calendar guard,
 * tenant-scope concealment, and the singular-`report` / uppercase-period
 * upstream resource path (LIVE pinned to `1970-01-01`). The 204 / link
 * validation matrix is already covered by the story route test against
 * the same helper.
 */

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

const mockHasPermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockGetSettings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/settings", () => ({
  getAimerIntegrationSettings: mockGetSettings,
}));

const mockHasSigningKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/signing-key", () => ({
  hasActiveAimerSigningKey: mockHasSigningKey,
}));

const mockResolveExternalKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/analysis/customer-external-key", () => ({
  resolveCustomerExternalKey: mockResolveExternalKey,
}));

const mockSignReadAuthToken = vi.hoisted(() => vi.fn());
const mockBuildReadAuthTokenPayload = vi.hoisted(() =>
  vi.fn((aiceId: string, externalKey: string) => ({
    iss: aiceId,
    aud: "aimer-web",
    aice_id: aiceId,
    customer_ids: [externalKey],
    iat: 1_700_000_000,
    exp: 1_700_000_060,
    jti: "test-jti",
  })),
);
vi.mock("@/lib/aimer/analysis/read-auth-token", () => ({
  AIMER_READ_AUTH_AUDIENCE: "aimer-web",
  AIMER_READ_AUTH_TOKEN_TTL_SECONDS: 60,
  buildReadAuthTokenPayload: mockBuildReadAuthTokenPayload,
  signReadAuthToken: mockSignReadAuthToken,
}));

function makeSession(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
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

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  currentSession = makeSession();
  mockHasPermission.mockReset().mockImplementation(async (_r, p) => {
    if (p === "customers:access-all") return false;
    return true;
  });
  mockResolveScope.mockReset().mockResolvedValue([42]);
  mockGetSettings.mockReset().mockResolvedValue({
    aiceId: "aice.example.com",
    bridgeUrl: "https://aimer.example.com",
    defaultModelName: "narrative-v1",
    defaultModel: "anthropic:claude-3",
  });
  mockHasSigningKey.mockReset().mockReturnValue(true);
  mockResolveExternalKey.mockReset().mockResolvedValue("acme-bridge-uuid");
  mockSignReadAuthToken.mockReset().mockResolvedValue("eyTEST.eyTOKEN.eySIG");
  mockBuildReadAuthTokenPayload.mockClear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  fetchSpy.mockRestore();
});

function mockUpstream(payload: unknown, init: ResponseInit = { status: 200 }) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
      ...init,
    }),
  );
}

// ── LIVE ──────────────────────────────────────────────────────────

describe("GET /api/aimer/analysis/reports/live/[customerId]/summary", () => {
  const importRoute = () =>
    import("@/app/api/aimer/analysis/reports/live/[customerId]/summary/route");

  function liveRequest(customerId: number | string) {
    return new NextRequest(
      `http://localhost/api/aimer/analysis/reports/live/${customerId}/summary`,
      { method: "GET" },
    );
  }
  function liveCtx(customerId: number | string) {
    return { params: Promise.resolve({ customerId: String(customerId) }) };
  }

  it("rejects an invalid customerId", async () => {
    const { GET } = await importRoute();
    const res = await GET(liveRequest("abc"), liveCtx("abc"));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 404 not_found for a cross-tenant customerId without reaching upstream", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { GET } = await importRoute();
    const res = await GET(liveRequest(42), liveCtx(42));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and builds the singular-report LIVE upstream path pinned to 1970-01-01", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "CRITICAL",
      severity_score: 0.91,
      likelihood_score: 0.77,
      score_kind: "aggregate",
      link: "/customers/acme-bridge-uuid/analysis/reports/LIVE/1970-01-01",
    });
    const { GET } = await importRoute();
    const res = await GET(liveRequest(42), liveCtx(42));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      exists: true,
      priority_tier: "CRITICAL",
      severity_score: 0.91,
      likelihood_score: 0.77,
      score_kind: "aggregate",
      link: "https://aimer.example.com/customers/acme-bridge-uuid/analysis/reports/LIVE/1970-01-01",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://aimer.example.com/api/customers/acme-bridge-uuid/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("returns 204 when the integration is unconfigured", async () => {
    mockGetSettings.mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: null,
      defaultModelName: null,
      defaultModel: null,
    });
    const { GET } = await importRoute();
    const res = await GET(liveRequest(42), liveCtx(42));
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emits a structured info log line carrying surface=live outcome=200", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.6,
      likelihood_score: 0.5,
      score_kind: "aggregate",
      link: "/customers/acme/analysis/reports/LIVE/1970-01-01",
    });
    const { GET } = await importRoute();
    await GET(liveRequest(42), liveCtx(42));
    const logged = infoSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .join("\n");
    expect(logged).toContain("surface=live");
    expect(logged).toContain("outcome=200");
    expect(logged).toContain("reason=ok");
  });
});

// ── DAILY ─────────────────────────────────────────────────────────

describe("GET /api/aimer/analysis/reports/daily/[customerId]/[date]/summary", () => {
  const importRoute = () =>
    import(
      "@/app/api/aimer/analysis/reports/daily/[customerId]/[date]/summary/route"
    );

  function dailyRequest(customerId: number | string, date: string) {
    return new NextRequest(
      `http://localhost/api/aimer/analysis/reports/daily/${customerId}/${date}/summary`,
      { method: "GET" },
    );
  }
  function dailyCtx(customerId: number | string, date: string) {
    return {
      params: Promise.resolve({ customerId: String(customerId), date }),
    };
  }

  it("rejects an invalid customerId", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      dailyRequest("abc", "2026-05-30"),
      dailyCtx("abc", "2026-05-30"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_customer_id" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "2026-02-30",
    "2026-13-01",
    "2026/05/30",
    "not-a-date",
    "",
  ])("returns 400 invalid_report_date for the malformed date %s before any upstream call", async (date) => {
    const { GET } = await importRoute();
    const res = await GET(dailyRequest(42, date), dailyCtx(42, date));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_report_date" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 404 not_found for a cross-tenant customerId without reaching upstream", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { GET } = await importRoute();
    const res = await GET(
      dailyRequest(42, "2026-05-30"),
      dailyCtx(42, "2026-05-30"),
    );
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and builds the singular-report DAILY upstream path with the date bucket", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.6,
      likelihood_score: 0.5,
      score_kind: "aggregate",
      link: "/customers/acme-bridge-uuid/analysis/reports/DAILY/2026-05-30",
    });
    const { GET } = await importRoute();
    const res = await GET(
      dailyRequest(42, "2026-05-30"),
      dailyCtx(42, "2026-05-30"),
    );
    expect(res.status).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://aimer.example.com/api/customers/acme-bridge-uuid/analysis/report/DAILY/2026-05-30/summary",
    );
  });

  it("admin (customers:access-all) skips the tenant-scope query", async () => {
    mockHasPermission.mockImplementation(async () => true);
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.6,
      likelihood_score: 0.5,
      score_kind: "aggregate",
      link: "/customers/acme/analysis/reports/DAILY/2026-05-30",
    });
    const { GET } = await importRoute();
    const res = await GET(
      dailyRequest(999, "2026-05-30"),
      dailyCtx(999, "2026-05-30"),
    );
    expect(res.status).toBe(200);
    expect(mockResolveScope).not.toHaveBeenCalled();
  });
});
