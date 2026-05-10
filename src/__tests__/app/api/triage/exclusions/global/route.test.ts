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
const mockListGlobalExclusions = vi.hoisted(() => vi.fn());
const mockCreateGlobalExclusion = vi.hoisted(() => vi.fn());
const mockEnqueueGlobalExclusionFanout = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/client", () => ({
  withTransaction: vi.fn((cb: (client: unknown) => unknown) =>
    mockWithTransaction(cb),
  ),
}));

vi.mock("@/lib/triage/exclusion/storage", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/exclusion/storage")
  >("@/lib/triage/exclusion/storage");
  return {
    ...actual,
    listGlobalExclusions: vi.fn((...args: unknown[]) =>
      mockListGlobalExclusions(...args),
    ),
    createGlobalExclusion: vi.fn((...args: unknown[]) =>
      mockCreateGlobalExclusion(...args),
    ),
    enqueueGlobalExclusionFanout: vi.fn((...args: unknown[]) =>
      mockEnqueueGlobalExclusionFanout(...args),
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

function makeContext() {
  return { params: Promise.resolve({}) };
}

const sampleRow = {
  id: "00000000-0000-0000-0000-000000000001",
  kind: "ipAddress" as const,
  value: "10.0.0.0/24",
  domainSuffix: null,
  note: null,
  createdBy: "admin-1",
  createdByDisplayName: null,
  createdAt: "2026-05-09T00:00:00.000Z",
};

describe("GET /api/triage/exclusions/global", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockListGlobalExclusions.mockReset();
  });

  it("lists global exclusions for triage:read", async () => {
    mockListGlobalExclusions.mockResolvedValue([sampleRow]);
    const { GET } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
    );
    const response = await GET(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual([sampleRow]);
  });

  it("returns 403 without triage:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
  });
});

describe("POST /api/triage/exclusions/global", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockCreateGlobalExclusion.mockReset();
    mockEnqueueGlobalExclusionFanout.mockReset();
    mockAuditRecord.mockReset();
    mockWithTransaction.mockReset().mockImplementation(async (cb) => cb({}));
  });

  it("creates a global exclusion and emits an audit row with fanoutEnqueued", async () => {
    mockCreateGlobalExclusion.mockResolvedValue(sampleRow);
    mockEnqueueGlobalExclusionFanout.mockResolvedValue({ enqueued: 7 });
    const { POST } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data).toEqual(sampleRow);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage_exclusion.global_add",
        target: "triage_exclusion",
        targetId: sampleRow.id,
        details: expect.objectContaining({ fanoutEnqueued: 7 }),
      }),
    );
  });

  it("returns 403 without triage:exclusion:global:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { POST } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
    expect(mockCreateGlobalExclusion).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { POST } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
      { method: "POST", body: "{not json" },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    expect(mockCreateGlobalExclusion).not.toHaveBeenCalled();
  });

  it("rejects an invalid kind via parseStoredExclusionInput", async () => {
    const { POST } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
      {
        method: "POST",
        body: JSON.stringify({ kind: "bogus", value: "x" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    expect(mockCreateGlobalExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 409 on duplicate (kind, value)", async () => {
    const { StoredExclusionConflictError } = await import(
      "@/lib/triage/exclusion/storage"
    );
    mockWithTransaction.mockImplementation(async () => {
      throw new StoredExclusionConflictError("ipAddress", "10.0.0.0/24");
    });
    const { POST } = await import("@/app/api/triage/exclusions/global/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("duplicate");
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});
