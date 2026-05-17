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

const mockRecordManualMint = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/manual-mint", () => ({
  recordManualMint: mockRecordManualMint,
}));

const mockLoadSingleStory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/story-push", () => ({
  loadSingleStoryWireItem: mockLoadSingleStory,
}));

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
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
  return new NextRequest(
    "http://localhost/api/aimer/phase2/story/build-envelope",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/aimer/phase2/story/build-envelope", () => {
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
      events_data: '{"stories":[]}',
      context_jti: "jti-manual",
    });
    mockRecordManualMint.mockReset().mockResolvedValue(undefined);
    mockLoadSingleStory.mockReset().mockResolvedValue({
      story_id: "1001",
      story_version: "v1",
      kind: "auto_correlated",
      time_window: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
      },
      members: [],
    });
    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
  });

  it("rejects invalid_request when storyIds (plural) is provided", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    const res = await POST(
      makeRequest({ customerId: 42, storyIds: ["1001"] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects when storyId is not a decimal string", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    const res = await POST(
      makeRequest({ customerId: 42, storyId: "abc" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_story_id" });
  });

  it("returns 404 when the caller cannot access the customer", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    const res = await POST(
      makeRequest({ customerId: 42, storyId: "1001" }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the story is missing", async () => {
    mockLoadSingleStory.mockResolvedValueOnce(null);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    const res = await POST(
      makeRequest({ customerId: 42, storyId: "9999" }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "story_not_found" });
  });

  it("mints envelope, records ledger row, returns multipart components", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    const res = await POST(
      makeRequest({ customerId: 42, storyId: "1001" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_version).toBe("phase2.story.v1");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/story/batch");
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/story/batch",
    );
    expect(body.context_jti).toBe("jti-manual");
    expect(mockBuildPush).toHaveBeenCalledTimes(1);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.schemaVersion).toBe("phase2.story.v1");
    expect(args.payload.stories).toHaveLength(1);
    expect(mockRecordManualMint).toHaveBeenCalledWith(42, {
      contextJti: "jti-manual",
      storyId: "1001",
      accountId: "account-1",
      forceRefresh: false,
    });
  });

  it("threads forceRefresh through to the loader and ledger", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/build-envelope/route"
    );
    await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        forceRefresh: true,
      }),
      ctx,
    );
    expect(mockLoadSingleStory).toHaveBeenCalledWith({
      customerId: 42,
      storyId: "1001",
      forceRefresh: true,
    });
    expect(mockRecordManualMint).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ forceRefresh: true }),
    );
  });
});
