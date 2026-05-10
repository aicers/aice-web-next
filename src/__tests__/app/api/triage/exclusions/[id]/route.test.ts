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
const mockQuery = vi.hoisted(() => vi.fn());
const mockListCustomerExclusions = vi.hoisted(() => vi.fn());
const mockDeleteCustomerExclusion = vi.hoisted(() => vi.fn());

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
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/triage/exclusion/storage", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/exclusion/storage")
  >("@/lib/triage/exclusion/storage");
  return {
    ...actual,
    listCustomerExclusions: vi.fn((...args: unknown[]) =>
      mockListCustomerExclusions(...args),
    ),
    deleteCustomerExclusion: vi.fn((...args: unknown[]) =>
      mockDeleteCustomerExclusion(...args),
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

const VALID_ID = "00000000-0000-0000-0000-000000000010";

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

describe("DELETE /api/triage/exclusions/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockListCustomerExclusions.mockReset();
    mockDeleteCustomerExclusion.mockReset();
    mockAuditRecord.mockReset();
    mockQuery.mockReset();
  });

  it("removes a customer exclusion and emits an audit row", async () => {
    mockListCustomerExclusions.mockResolvedValue([sampleRow]);
    mockDeleteCustomerExclusion.mockResolvedValue(true);
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}?customer_id=42`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(200);
    expect(mockDeleteCustomerExclusion).toHaveBeenCalledWith(42, VALID_ID);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage_exclusion.customer_remove",
        target: "triage_exclusion",
        targetId: VALID_ID,
        customerId: 42,
        details: expect.objectContaining({
          id: VALID_ID,
          kind: "ipAddress",
          value: "10.0.0.0/24",
        }),
      }),
    );
  });

  it("returns 400 when customer_id is missing", async () => {
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(400);
    expect(mockDeleteCustomerExclusion).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed UUID", async () => {
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/not-a-uuid?customer_id=42",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("not-a-uuid"));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the row does not exist for the customer", async () => {
    mockListCustomerExclusions.mockResolvedValue([]);
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}?customer_id=42`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(404);
    expect(mockDeleteCustomerExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 403 without triage:exclusion:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}?customer_id=42`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(403);
    expect(mockDeleteCustomerExclusion).not.toHaveBeenCalled();
  });

  it("denies an out-of-scope caller (not access-all, no membership)", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "customers:access-all",
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { DELETE } = await import("@/app/api/triage/exclusions/[id]/route");
    const request = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}?customer_id=42`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(VALID_ID));
    expect(response.status).toBe(403);
    expect(mockListCustomerExclusions).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});
