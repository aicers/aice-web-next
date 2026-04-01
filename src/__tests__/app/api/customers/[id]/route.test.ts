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

const mockQuery = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockDropCustomerDb = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/migrate", () => ({
  dropCustomerDb: vi.fn((...args: unknown[]) => mockDropCustomerDb(...args)),
}));

// ── Helpers ─────────────────────────────────────────────────────

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

const sampleCustomer = {
  id: 1,
  name: "Acme Corp",
  description: "A test customer",
  database_name: "customer_acme_corp_abc123",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function makeContext(id = "1") {
  return { params: Promise.resolve({ id }) };
}

// ── GET /api/customers/[id] ─────────────────────────────────────

describe("GET /api/customers/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("returns a customer by ID", async () => {
    mockQuery.mockResolvedValue({ rows: [sampleCustomer], rowCount: 1 });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1");
    const response = await GET(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("Acme Corp");
  });

  it("returns 404 for non-existent customer", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/999");
    const response = await GET(request, makeContext("999"));

    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid ID", async () => {
    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/abc");
    const response = await GET(request, makeContext("abc"));

    expect(response.status).toBe(400);
  });

  it("scopes by tenant when lacking customers:access-all", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // First: SELECT customer, then: SELECT account_customer link
    mockQuery
      .mockResolvedValueOnce({ rows: [sampleCustomer], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no link

    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1");
    const response = await GET(request, makeContext());

    expect(response.status).toBe(404);
  });
});

// ── PATCH /api/customers/[id] ───────────────────────────────────

describe("PATCH /api/customers/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("updates name and description", async () => {
    const updated = { ...sampleCustomer, name: "New Name" };

    mockQuery
      .mockResolvedValueOnce({ rows: [sampleCustomer], rowCount: 1 }) // SELECT
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // UPDATE

    const { PATCH } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
    });
    const response = await PATCH(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("New Name");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.update",
        target: "customer",
        targetId: "1",
      }),
    );
  });

  it("returns 404 for non-existent customer", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { PATCH } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/999", {
      method: "PATCH",
      body: JSON.stringify({ name: "X" }),
    });
    const response = await PATCH(request, makeContext("999"));

    expect(response.status).toBe(404);
  });

  it("returns 400 for empty name", async () => {
    const { PATCH } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ name: "  " }),
    });
    const response = await PATCH(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 404 when Tenant Admin updates customer outside their scope", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Customer exists, but no account_customer link
    mockQuery
      .mockResolvedValueOnce({ rows: [sampleCustomer], rowCount: 1 }) // SELECT customer
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT account_customer

    const { PATCH } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
    });
    const response = await PATCH(request, makeContext());

    expect(response.status).toBe(404);
  });

  it("returns existing customer when no fields to update", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [sampleCustomer],
      rowCount: 1,
    });

    const { PATCH } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    const response = await PATCH(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("Acme Corp");
  });
});

// ── DELETE /api/customers/[id] ──────────────────────────────────

describe("DELETE /api/customers/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockDropCustomerDb.mockReset().mockResolvedValue(undefined);
  });

  it("deletes a customer and drops its database", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [sampleCustomer], rowCount: 1 }) // SELECT customer
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT account_customer
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE

    const { DELETE } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "DELETE",
    });
    const response = await DELETE(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockDropCustomerDb).toHaveBeenCalledWith(
      sampleCustomer.database_name,
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.delete",
        target: "customer",
        targetId: "1",
      }),
    );
  });

  it("returns 400 when customer has linked accounts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [sampleCustomer], rowCount: 1 }) // SELECT customer
      .mockResolvedValueOnce({
        rows: [{ customer_id: 1 }],
        rowCount: 1,
      }); // SELECT account_customer

    const { DELETE } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "DELETE",
    });
    const response = await DELETE(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("active account assignments");
    expect(mockDropCustomerDb).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent customer", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { DELETE } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/999", {
      method: "DELETE",
    });
    const response = await DELETE(request, makeContext("999"));

    expect(response.status).toBe(404);
  });

  it("returns 403 without customers:delete permission", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:delete") return false;
        return true;
      },
    );

    const { DELETE } = await import("@/app/api/customers/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/customers/1", {
      method: "DELETE",
    });
    const response = await DELETE(request, makeContext());

    expect(response.status).toBe(403);
  });
});
