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
const mockListPolicies = vi.hoisted(() => vi.fn());
const mockCreatePolicy = vi.hoisted(() => vi.fn());

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
    listPolicies: vi.fn((...args: unknown[]) => mockListPolicies(...args)),
    createPolicy: vi.fn((...args: unknown[]) => mockCreatePolicy(...args)),
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
  id: 7,
  name: "policy-a",
  packet_attr: [],
  confidence: [],
  response: [],
  created_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
};

describe("GET /api/triage/policies", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockListPolicies.mockReset();
    mockQuery.mockReset();
  });

  it("returns 400 when customer_id is missing", async () => {
    const { GET } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("returns 400 when customer_id is non-positive", async () => {
    const { GET } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=0",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("lists policies for an access-all caller", async () => {
    mockListPolicies.mockResolvedValue([sampleRow]);
    const { GET } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
    );
    const response = await GET(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual([sampleRow]);
    expect(mockListPolicies).toHaveBeenCalledWith(42);
  });

  it("denies access when caller lacks scope and is not access-all", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { GET } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
  });

  it("returns 403 without triage:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
  });
});

describe("POST /api/triage/policies", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockCreatePolicy.mockReset();
    mockAuditRecord.mockReset();
    mockQuery.mockReset();
  });

  it("creates a policy and emits an audit event", async () => {
    mockCreatePolicy.mockResolvedValue(sampleRow);
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "policy-a",
          packet_attr: [],
          confidence: [],
          response: [],
        }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data).toEqual(sampleRow);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage.policy.create",
        target: "triage_policy",
        targetId: "7",
        customerId: 42,
      }),
    );
  });

  it("rejects an invalid IP/CIDR in a packet_attr ipaddr rule", async () => {
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "p",
          packet_attr: [
            {
              raw_event_kind: "conn",
              attr_name: "src_addr",
              value_kind: "ipaddr",
              cmp_kind: "equal",
              first_value: "not-an-ip",
            },
          ],
          confidence: [],
          response: [],
        }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details).toBeDefined();
    expect(mockCreatePolicy).not.toHaveBeenCalled();
  });

  it("rejects a legacy 'match' cmp_kind that is not in AttrCmpKind", async () => {
    // `match` / `not_match` were dropped in Round 5 to keep the stored
    // shape aligned with review-web's `AttrCmpKind` enum (see
    // src/lib/triage/inline-policy/kinds.ts). Zod's enum check now
    // rejects the value before it ever reaches the repository.
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "p",
          packet_attr: [
            {
              raw_event_kind: "http",
              attr_name: "host",
              value_kind: "string",
              cmp_kind: "match",
              first_value: "foo",
            },
          ],
          confidence: [],
          response: [],
        }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    expect(mockCreatePolicy).not.toHaveBeenCalled();
  });

  it("rejects a range cmp_kind without a second_value", async () => {
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "p",
          packet_attr: [
            {
              raw_event_kind: "conn",
              attr_name: "duration",
              value_kind: "integer",
              cmp_kind: "open_range",
              first_value: "100",
            },
          ],
          confidence: [],
          response: [],
        }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details).toBeDefined();
    expect(mockCreatePolicy).not.toHaveBeenCalled();
  });

  it("rejects an unknown raw_event_kind not in the GraphQL RawEventKind enum", async () => {
    // `raw_event_kind` is a closed enum aligned with `RawEventKind` in
    // schemas/review.graphql; values like "Conn" (wrong case) or
    // "unknown" must be rejected so the stored row can be passed inline
    // to the future scoring engine without a kind it has no name for.
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "p",
          packet_attr: [
            {
              raw_event_kind: "Conn",
              attr_name: "src_addr",
              value_kind: "ipaddr",
              cmp_kind: "equal",
              first_value: "10.0.0.1",
            },
          ],
          confidence: [],
          response: [],
        }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details).toBeDefined();
    expect(mockCreatePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      { method: "POST", body: "{not json" },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("rejects unknown keys (typo'd field) without persisting an empty-rule policy", async () => {
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "policy-a",
          packet_attrs: [
            {
              raw_event_kind: "conn",
              attr_name: "src_addr",
              value_kind: "ipaddr",
              cmp_kind: "equal",
              first_value: "10.0.0.1",
            },
          ],
        }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details).toBeDefined();
    expect(mockCreatePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects unrecognized top-level keys", async () => {
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({
          name: "policy-a",
          packet_attr: [],
          confidence: [],
          response: [],
          extra: "junk",
        }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    expect(mockCreatePolicy).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 403 without triage:policy:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { POST } = await import("@/app/api/triage/policies/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/policies?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({ name: "p" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
  });
});
