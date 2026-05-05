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

const mockGenerate = vi.hoisted(() => vi.fn());
const mockRotate = vi.hoisted(() => vi.fn());
const mockSwitch = vi.hoisted(() => vi.fn());
const mockDeactivate = vi.hoisted(() => vi.fn());
const mockGetStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/aimer/signing-key", () => ({
  generateAimerSigningKey: mockGenerate,
  rotateAimerSigningKey: mockRotate,
  switchAimerSigningKey: mockSwitch,
  deactivateAimerSigningPreviousKey: mockDeactivate,
  getAimerSigningKeyStatus: mockGetStatus,
}));

const mockAuditRecord = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const now = Math.floor(Date.now() / 1000);
const baseSession: AuthSession = {
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

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "http://localhost/api/aimer-integration/keypair/actions",
    { method: "POST", body: JSON.stringify(body) },
  );
}

function makeContext() {
  return { params: Promise.resolve({}) };
}

describe("POST /api/aimer-integration/keypair/actions", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockRotate.mockReset();
    mockSwitch.mockReset();
    mockDeactivate.mockReset();
    mockGetStatus.mockReset().mockResolvedValue({ state: "empty" });
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    currentSession = baseSession;
  });

  it("denies non-System-Administrator role even with broad permissions", async () => {
    currentSession = {
      ...baseSession,
      roles: ["Tenant Administrator"],
    };
    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(makeRequest({ action: "generate" }), makeContext());
    expect(res.status).toBe(403);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("denies Security Monitor", async () => {
    currentSession = { ...baseSession, roles: ["Security Monitor"] };
    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(makeRequest({ action: "generate" }), makeContext());
    expect(res.status).toBe(403);
  });

  it("rejects unknown action with 400", async () => {
    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(makeRequest({ action: "fly" }), makeContext());
    expect(res.status).toBe(400);
  });

  it("dispatches generate and audit-logs the result", async () => {
    mockGenerate.mockResolvedValue({ kid: "k1" });
    mockGetStatus.mockResolvedValue({
      state: "active_only",
      active: { kid: "k1" },
    });

    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(makeRequest({ action: "generate" }), makeContext());
    expect(res.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_signing_key.generated",
        target: "system_settings",
        targetId: "k1",
      }),
    );
  });

  it("forwards confirmRegistered=true for switch", async () => {
    mockSwitch.mockResolvedValue({ activeKid: "k2", previousKid: "k1" });
    mockGetStatus.mockResolvedValue({ state: "active_and_previous" });

    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(
      makeRequest({ action: "switch", confirmRegistered: true }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mockSwitch).toHaveBeenCalledWith({ confirmRegistered: true });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "aimer_signing_key.switched" }),
    );
  });

  it("propagates underlying refusal as 400", async () => {
    mockSwitch.mockRejectedValue(new Error("confirmation required"));
    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(
      makeRequest({ action: "switch", confirmRegistered: false }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("audit-logs deactivate with the previous kid", async () => {
    mockDeactivate.mockReturnValue({ previousKid: "k1" });
    mockGetStatus.mockResolvedValue({ state: "active_only" });

    const { POST } = await import(
      "@/app/api/aimer-integration/keypair/actions/route"
    );
    const res = await POST(
      makeRequest({ action: "deactivate" }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mockDeactivate).toHaveBeenCalledWith({ force: false });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_signing_key.deactivated",
        targetId: "k1",
      }),
    );
  });
});
