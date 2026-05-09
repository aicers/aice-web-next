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
const mockGetPolicy = vi.hoisted(() => vi.fn());
const mockUpdatePolicy = vi.hoisted(() => vi.fn());
const mockDeletePolicy = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/triage/policy/repository", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/policy/repository")
  >("@/lib/triage/policy/repository");
  return {
    ...actual,
    getPolicy: vi.fn((...args: unknown[]) => mockGetPolicy(...args)),
    updatePolicy: vi.fn((...args: unknown[]) => mockUpdatePolicy(...args)),
    deletePolicy: vi.fn((...args: unknown[]) => mockDeletePolicy(...args)),
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

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const sampleRow = {
  id: 7,
  name: "policy-a",
  packet_attr: [],
  confidence: [],
  response: [],
  created_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
};

describe("GET /api/triage/policies/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetPolicy.mockReset();
    mockQuery.mockReset();
  });

  it("returns 400 when customer_id is missing", async () => {
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7",
    );
    const response = await GET(request, makeContext("7"));
    expect(response.status).toBe(400);
  });

  it("returns 400 when policy id is non-numeric", async () => {
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/not-a-number?customer_id=42",
    );
    const response = await GET(request, makeContext("not-a-number"));
    expect(response.status).toBe(400);
  });

  it("returns the policy for an access-all caller", async () => {
    mockGetPolicy.mockResolvedValue(sampleRow);
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
    );
    const response = await GET(request, makeContext("7"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual(sampleRow);
    expect(mockGetPolicy).toHaveBeenCalledWith(42, 7);
  });

  it("returns 404 when the row does not exist", async () => {
    mockGetPolicy.mockResolvedValue(null);
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
    );
    const response = await GET(request, makeContext("7"));
    expect(response.status).toBe(404);
  });

  it("denies access when caller lacks scope and is not access-all", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
    );
    const response = await GET(request, makeContext("7"));
    expect(response.status).toBe(403);
  });

  it("returns 403 without triage:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
    );
    const response = await GET(request, makeContext("7"));
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/triage/policies/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockUpdatePolicy.mockReset();
    mockAuditRecord.mockReset();
    mockQuery.mockReset();
  });

  it("returns 403 without triage:policy:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ name: "renamed" }) },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(403);
  });

  it("rejects an empty body with no recognized fields", async () => {
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({}) },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(400);
    expect(mockUpdatePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects bodies whose only keys are typos (strict schema)", async () => {
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ respnose: [] }) },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(400);
    expect(mockUpdatePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: "{not json" },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(400);
  });

  it("rejects an invalid IP/CIDR in a packet_attr ipaddr rule", async () => {
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      {
        method: "PATCH",
        body: JSON.stringify({
          packet_attr: [
            {
              raw_event_kind: "conn",
              attr_name: "src_addr",
              value_kind: "ipaddr",
              cmp_kind: "equal",
              first_value: "10.0.0.0/40",
            },
          ],
        }),
      },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(400);
    expect(mockUpdatePolicy).not.toHaveBeenCalled();
  });

  it("rejects a range cmp_kind without a second_value", async () => {
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      {
        method: "PATCH",
        body: JSON.stringify({
          packet_attr: [
            {
              raw_event_kind: "conn",
              attr_name: "duration",
              value_kind: "integer",
              cmp_kind: "close_range",
              first_value: "100",
            },
          ],
        }),
      },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(400);
    expect(mockUpdatePolicy).not.toHaveBeenCalled();
  });

  it("returns 404 when the row does not exist", async () => {
    mockUpdatePolicy.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ name: "renamed" }) },
    );
    const response = await PATCH(request, makeContext("7"));
    expect(response.status).toBe(404);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("maps a name conflict to a 409 with code 'name_conflict'", async () => {
    const { TriagePolicyNameConflictError } = await import(
      "@/lib/triage/policy/repository"
    );
    mockUpdatePolicy.mockRejectedValue(
      new TriagePolicyNameConflictError("policy-a"),
    );
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ name: "policy-a" }) },
    );
    const response = await PATCH(request, makeContext("7"));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("name_conflict");
  });

  it("updates the policy and emits an audit event", async () => {
    mockUpdatePolicy.mockResolvedValue({ ...sampleRow, name: "renamed" });
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ name: "renamed" }) },
    );
    const response = await PATCH(request, makeContext("7"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.name).toBe("renamed");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage.policy.update",
        target: "triage_policy",
        targetId: "7",
        customerId: 42,
        details: expect.objectContaining({
          changedFields: ["name"],
        }),
      }),
    );
  });

  it("does not overwrite omitted rule arrays on a name-only patch", async () => {
    // Round 2 regression: previously `policyBaseSchema.partial()` kept
    // the `.default([])` on rule arrays, so a name-only PATCH wiped
    // every existing rule list. Confirm the repository receives only
    // the fields that were actually present in the request.
    mockUpdatePolicy.mockResolvedValue({ ...sampleRow, name: "renamed" });
    const { PATCH } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "PATCH", body: JSON.stringify({ name: "renamed" }) },
    );
    await PATCH(request, makeContext("7"));
    expect(mockUpdatePolicy).toHaveBeenCalledTimes(1);
    const updateInput = mockUpdatePolicy.mock.calls[0][2];
    expect(updateInput).toEqual({ name: "renamed" });
    expect(updateInput.packet_attr).toBeUndefined();
    expect(updateInput.confidence).toBeUndefined();
    expect(updateInput.response).toBeUndefined();
  });
});

describe("DELETE /api/triage/policies/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetPolicy.mockReset();
    mockDeletePolicy.mockReset();
    mockAuditRecord.mockReset();
    mockQuery.mockReset();
  });

  it("returns 403 without triage:policy:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { DELETE } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("7"));
    expect(response.status).toBe(403);
  });

  it("returns 404 when the row does not exist", async () => {
    mockGetPolicy.mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("7"));
    expect(response.status).toBe(404);
    expect(mockDeletePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("deletes the policy and emits an audit event with the captured name", async () => {
    mockGetPolicy.mockResolvedValue(sampleRow);
    mockDeletePolicy.mockResolvedValue(true);
    const { DELETE } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("7"));
    expect(response.status).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage.policy.delete",
        target: "triage_policy",
        targetId: "7",
        customerId: 42,
        details: { name: "policy-a" },
      }),
    );
  });

  it("denies access when caller lacks scope and is not access-all", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { DELETE } = await import("@/app/api/triage/policies/[id]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies/7?customer_id=42",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("7"));
    expect(response.status).toBe(403);
    expect(mockDeletePolicy).not.toHaveBeenCalled();
  });
});
