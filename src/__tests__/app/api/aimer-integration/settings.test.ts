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

const mockUpdate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/aimer/settings")>(
    "@/lib/aimer/settings",
  );
  return {
    ...actual,
    updateAimerIntegrationSetting: mockUpdate,
    getAimerIntegrationSettings: mockGet,
  };
});

const mockAuditRecord = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const now = Math.floor(Date.now() / 1000);
const adminSession: AuthSession = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
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

function makeRequest(key: string, body: unknown) {
  return new NextRequest(
    `http://localhost/api/aimer-integration/settings/${key}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

function makeContext(key: string) {
  return { params: Promise.resolve({ key }) };
}

describe("PATCH /api/aimer-integration/settings/[key]", () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    mockGet.mockReset();
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    currentSession = adminSession;
  });

  it("denies Tenant Administrator", async () => {
    currentSession = { ...adminSession, roles: ["Tenant Administrator"] };
    const { PATCH } = await import(
      "@/app/api/aimer-integration/settings/[key]/route"
    );
    const res = await PATCH(
      makeRequest("aice_id", { value: "x.example.com" }),
      makeContext("aice_id"),
    );
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects unknown key", async () => {
    const { PATCH } = await import(
      "@/app/api/aimer-integration/settings/[key]/route"
    );
    const res = await PATCH(
      makeRequest("nope", { value: "v" }),
      makeContext("nope"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-string value", async () => {
    const { PATCH } = await import(
      "@/app/api/aimer-integration/settings/[key]/route"
    );
    const res = await PATCH(
      makeRequest("aice_id", { value: 123 }),
      makeContext("aice_id"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when validation fails", async () => {
    mockUpdate.mockResolvedValue({ valid: false, error: "bad hostname" });
    const { PATCH } = await import(
      "@/app/api/aimer-integration/settings/[key]/route"
    );
    const res = await PATCH(
      makeRequest("aice_id", { value: "_bad" }),
      makeContext("aice_id"),
    );
    expect(res.status).toBe(400);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("audit-logs the {key, old, new} triple on success", async () => {
    mockUpdate.mockResolvedValue({
      valid: true,
      oldValue: null,
      newValue: "https://aimer.example.com",
    });
    const { PATCH } = await import(
      "@/app/api/aimer-integration/settings/[key]/route"
    );
    const res = await PATCH(
      makeRequest("clumit_insight_bridge_url", {
        value: "https://aimer.example.com",
      }),
      makeContext("clumit_insight_bridge_url"),
    );
    expect(res.status).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_integration_setting.changed",
        target: "system_settings",
        targetId: "clumit_insight_bridge_url",
        details: expect.objectContaining({
          key: "clumit_insight_bridge_url",
          old: null,
          new: "https://aimer.example.com",
        }),
      }),
    );
  });
});
