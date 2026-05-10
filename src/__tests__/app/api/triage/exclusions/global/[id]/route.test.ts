import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockGetGlobalExclusionById = vi.hoisted(() => vi.fn());
const mockDeleteGlobalExclusion = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;

vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> },
    ) => {
      if (options?.requiredPermissions) {
        for (const perm of options.requiredPermissions) {
          if (!(await mockHasPermission(currentSession.roles, perm))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
      }
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/triage/exclusion/storage", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/exclusion/storage")
  >("@/lib/triage/exclusion/storage");
  return {
    ...actual,
    getGlobalExclusionById: vi.fn((...args: unknown[]) =>
      mockGetGlobalExclusionById(...args),
    ),
    deleteGlobalExclusion: vi.fn((...args: unknown[]) =>
      mockDeleteGlobalExclusion(...args),
    ),
  };
});

const now = Math.floor(Date.now() / 1000);
const adminSession: AuthSession = {
  accountId: "admin-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

const VALID_ID = "00000000-0000-0000-0000-000000000001";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const sampleRow = {
  id: VALID_ID,
  kind: "ipAddress" as const,
  value: "10.0.0.0/24",
  domainSuffix: null,
  note: null,
  createdBy: "admin-1",
  createdByDisplayName: null,
  createdAt: "2026-05-09T00:00:00.000Z",
};

describe("DELETE /api/triage/exclusions/global/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetGlobalExclusionById.mockReset();
    mockDeleteGlobalExclusion.mockReset();
    mockAuditRecord.mockReset();
  });

  it("removes a global exclusion and emits an audit row", async () => {
    mockGetGlobalExclusionById.mockResolvedValue(sampleRow);
    mockDeleteGlobalExclusion.mockResolvedValue(true);
    const { DELETE } = await import(
      "@/app/api/triage/exclusions/global/[id]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(200);
    expect(mockDeleteGlobalExclusion).toHaveBeenCalledWith(VALID_ID);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage_exclusion.global_remove",
        target: "triage_exclusion",
        targetId: VALID_ID,
        details: expect.objectContaining({
          id: VALID_ID,
          kind: "ipAddress",
          value: "10.0.0.0/24",
        }),
      }),
    );
  });

  it("returns 400 for a malformed UUID", async () => {
    const { DELETE } = await import(
      "@/app/api/triage/exclusions/global/[id]/route"
    );
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global/not-a-uuid",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(mockGetGlobalExclusionById).not.toHaveBeenCalled();
  });

  it("returns 404 when the row does not exist", async () => {
    mockGetGlobalExclusionById.mockResolvedValue(null);
    const { DELETE } = await import(
      "@/app/api/triage/exclusions/global/[id]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(404);
    expect(mockDeleteGlobalExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 403 without triage:exclusion:global:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { DELETE } = await import(
      "@/app/api/triage/exclusions/global/[id]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(403);
    expect(mockGetGlobalExclusionById).not.toHaveBeenCalled();
  });
});
