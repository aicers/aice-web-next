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

function makeRequest(customerId: number | string, storyId: string) {
  return new NextRequest(
    `http://localhost/api/aimer/analysis/story/${customerId}/${storyId}/summary`,
    { method: "GET" },
  );
}

function ctxFor(customerId: number | string, storyId: string) {
  return {
    params: Promise.resolve({
      customerId: String(customerId),
      storyId,
    }),
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
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
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(() => {
  warnSpy.mockRestore();
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

describe("GET /api/aimer/analysis/story/[customerId]/[storyId]/summary", () => {
  it("rejects invalid customerId", async () => {
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest("abc", "1001"), ctxFor("abc", "1001"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid storyId", async () => {
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "abc"), ctxFor(42, "abc"));
    expect(res.status).toBe(400);
  });

  it("returns 404 not_found for cross-tenant customerId", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // Upstream must not have been reached.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 204 when the bridge URL is unconfigured", async () => {
    mockGetSettings.mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: null,
      defaultModelName: null,
      defaultModel: null,
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 204 when aice_id is unconfigured", async () => {
    mockGetSettings.mockResolvedValue({
      aiceId: null,
      bridgeUrl: "https://aimer.example.com",
      defaultModelName: null,
      defaultModel: null,
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 204 when the signing key is missing", async () => {
    mockHasSigningKey.mockReturnValue(false);
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 204 when upstream returns 404", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns 204 when upstream reports exists: false", async () => {
    mockUpstream({ exists: false });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
  });

  it.each(["LOW", "MEDIUM"])("returns 204 for tier %s", async (tier) => {
    mockUpstream({
      exists: true,
      priority_tier: tier,
      severity_score: 0.4,
      likelihood_score: 0.2,
      score_kind: "leaf",
      link: "/analysis/story/123",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
  });

  it("returns 204 + warn log when upstream link is not a relative path", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "CRITICAL",
      severity_score: 0.9,
      likelihood_score: 0.8,
      score_kind: "leaf",
      // Absolute URL — must be rejected to avoid open-redirect risk.
      link: "https://evil.example.com/phish",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns 204 + warn log when upstream link contains a traversal segment", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.7,
      likelihood_score: 0.6,
      score_kind: "leaf",
      link: "/analysis/../admin",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns 204 + warn log when upstream link is protocol-relative", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.7,
      likelihood_score: 0.6,
      score_kind: "leaf",
      link: "//evil.example.com/phish",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns 204 + warn log on upstream fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns 200 with composed absolute href for a valid CRITICAL summary", async () => {
    mockUpstream({
      exists: true,
      priority_tier: "CRITICAL",
      severity_score: 0.92,
      likelihood_score: 0.88,
      score_kind: "leaf",
      link: "/analysis/story/123",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(42, "1001"), ctxFor(42, "1001"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      tier: "CRITICAL",
      href: "https://aimer.example.com/analysis/story/123",
      severityScore: 0.92,
      likelihoodScore: 0.88,
      scoreKind: "leaf",
    });
    // Upstream URL was composed from bridgeUrl + path-encoded storyId.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://aimer.example.com/api/analysis/story/1001/summary",
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-aice-id"]).toBe("aice.example.com");
  });

  it("admin (customers:access-all) skips the tenant-scope query and is served upstream", async () => {
    mockHasPermission.mockImplementation(async () => true);
    mockUpstream({
      exists: true,
      priority_tier: "HIGH",
      severity_score: 0.6,
      likelihood_score: 0.5,
      score_kind: "leaf",
      link: "/analysis/story/77",
    });
    const { GET } = await import(
      "@/app/api/aimer/analysis/story/[customerId]/[storyId]/summary/route"
    );
    const res = await GET(makeRequest(999, "1001"), ctxFor(999, "1001"));
    expect(res.status).toBe(200);
    expect(mockResolveScope).not.toHaveBeenCalled();
  });
});
