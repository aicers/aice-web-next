import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ManualMintConsumeError } from "@/lib/aimer/phase2/manual-mint";
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

const mockConsume = vi.hoisted(() => vi.fn());
const mockStoryExists = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/manual-mint", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/aimer/phase2/manual-mint")
  >("@/lib/aimer/phase2/manual-mint");
  return {
    ...actual,
    consumeManualMintAndBumpBeta: mockConsume,
    storyExistsForCustomer: mockStoryExists,
  };
});

const mockAuditRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
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
  return new NextRequest("http://localhost/api/aimer/phase2/story/ack-manual", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/aimer/phase2/story/ack-manual", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockHasPermission.mockReset().mockImplementation(async (_r, p) => {
      if (p === "customers:access-all") return false;
      return true;
    });
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockStoryExists.mockReset().mockResolvedValue(true);
    mockConsume.mockReset().mockResolvedValue({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 3,
      forceRefresh: false,
      storyVersion: "v1",
    });
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
  });

  it("returns 404 when the caller is out of scope", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/ack-manual/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        contextJti: "jti-manual",
        forceRefresh: false,
        duplicatesSkipped: 0,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the story does not exist", async () => {
    mockStoryExists.mockResolvedValue(false);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/ack-manual/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        contextJti: "jti-manual",
        forceRefresh: false,
        duplicatesSkipped: 0,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "story_not_found" });
  });

  it("returns 409 on replay_or_unknown_jti", async () => {
    mockConsume.mockRejectedValueOnce(
      new ManualMintConsumeError("replay_or_unknown_jti", "missing"),
    );
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/ack-manual/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        contextJti: "jti-manual",
        forceRefresh: false,
        duplicatesSkipped: 0,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "replay_or_unknown_jti" });
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("commits β + emits triage.story.send audit on success", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/ack-manual/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        contextJti: "jti-manual",
        forceRefresh: false,
        duplicatesSkipped: 1,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 3,
    });
    expect(mockConsume).toHaveBeenCalledWith(42, {
      contextJti: "jti-manual",
      storyId: "1001",
      accountId: "account-1",
    });
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const auditArg = mockAuditRecord.mock.calls[0][0];
    expect(auditArg.action).toBe("triage.story.send");
    expect(auditArg.targetId).toBe("1001");
    expect(auditArg.customerId).toBe(42);
    expect(auditArg.actor).toBe("account-1");
    expect(auditArg.details.trigger).toBe("manual");
    expect(auditArg.details.duplicatesSkipped).toBe(1);
    // forceRefresh comes from the ledger, not the request body.
    expect(auditArg.details.forceRefresh).toBe(false);
  });

  it("ignores a tampered forceRefresh on the request body", async () => {
    mockConsume.mockResolvedValueOnce({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 1,
      forceRefresh: false, // ledger says non-force
      storyVersion: "v1",
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/ack-manual/route"
    );
    await POST(
      makeRequest({
        customerId: 42,
        storyId: "1001",
        contextJti: "jti-manual",
        // Body says force; ledger says no — audit should say no.
        forceRefresh: true,
        duplicatesSkipped: 0,
      }),
      ctx,
    );
    expect(mockAuditRecord.mock.calls[0][0].details.forceRefresh).toBe(false);
  });
});
