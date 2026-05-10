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
const mockCreateCustomerExclusion = vi.hoisted(() => vi.fn());
const mockConnectCustomerClient = vi.hoisted(() => vi.fn());
const mockExecuteFirstBatch = vi.hoisted(() => vi.fn());
const mockDrainRemaining = vi.hoisted(() => vi.fn());
const mockAcquireLock = vi.hoisted(() => vi.fn());
const mockGetCustomerPool = vi.hoisted(() => vi.fn());

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
    createCustomerExclusion: vi.fn((...args: unknown[]) =>
      mockCreateCustomerExclusion(...args),
    ),
    connectCustomerClient: vi.fn((...args: unknown[]) =>
      mockConnectCustomerClient(...args),
    ),
  };
});

vi.mock("@/lib/triage/exclusion/retroactive-delete", () => ({
  acquireCustomerCadenceLock: vi.fn((...args: unknown[]) =>
    mockAcquireLock(...args),
  ),
  executeFirstRetroactiveDeleteBatch: vi.fn((...args: unknown[]) =>
    mockExecuteFirstBatch(...args),
  ),
  drainRemainingRetroactiveDeletes: vi.fn((...args: unknown[]) =>
    mockDrainRemaining(...args),
  ),
}));

vi.mock("@/lib/triage/policy/customer-db", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/policy/customer-db")
  >("@/lib/triage/policy/customer-db");
  return {
    ...actual,
    getCustomerPool: vi.fn((...args: unknown[]) =>
      mockGetCustomerPool(...args),
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
  id: "00000000-0000-0000-0000-000000000010",
  kind: "ipAddress" as const,
  value: "10.0.0.0/24",
  domainSuffix: null,
  note: null,
  createdBy: "admin-1",
  createdByDisplayName: null,
  createdAt: "2026-05-09T00:00:00.000Z",
};

function makeFakeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
}

describe("GET /api/triage/exclusions", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockListCustomerExclusions.mockReset();
    mockQuery.mockReset();
  });

  it("returns 400 when customer_id is missing", async () => {
    const { GET } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("lists customer exclusions for an access-all caller", async () => {
    mockListCustomerExclusions.mockResolvedValue([sampleRow]);
    const { GET } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
    );
    const response = await GET(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual([sampleRow]);
    expect(mockListCustomerExclusions).toHaveBeenCalledWith(42);
  });

  it("denies an out-of-scope caller (not access-all, no membership)", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "customers:access-all",
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { GET } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
    expect(mockListCustomerExclusions).not.toHaveBeenCalled();
  });

  it("returns 403 without triage:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
  });
});

describe("POST /api/triage/exclusions", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockListCustomerExclusions.mockReset();
    mockCreateCustomerExclusion.mockReset();
    mockAuditRecord.mockReset();
    mockQuery.mockReset();
    mockAcquireLock.mockReset().mockResolvedValue(undefined);
    mockExecuteFirstBatch.mockReset().mockResolvedValue({
      counts: {
        baselineTriagedEvent: 0,
        observedEventMeta: 0,
        policyTriagedEvent: null,
      },
      pending: [],
    });
    mockDrainRemaining.mockReset();
    mockGetCustomerPool.mockReset();
    mockConnectCustomerClient
      .mockReset()
      .mockImplementation(async () => makeFakeClient());
  });

  it("creates a customer exclusion and emits an audit row", async () => {
    mockCreateCustomerExclusion.mockResolvedValue(sampleRow);
    const { POST } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
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
        action: "triage_exclusion.customer_add",
        target: "triage_exclusion",
        targetId: sampleRow.id,
        customerId: 42,
        details: expect.objectContaining({
          deletedCorpusRows: expect.objectContaining({
            baselineTriagedEvent: 0,
          }),
        }),
      }),
    );
  });

  it("returns 403 without triage:exclusion:write", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { POST } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
    expect(mockCreateCustomerExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("denies an out-of-scope caller before mutating", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "customers:access-all",
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { POST } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
    expect(mockCreateCustomerExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 500 with the row id when the drain phase fails (round 3)", async () => {
    // Round-3 review: a drain failure must not return a hidden 201
    // warning the UI ignores. The INSERT and first batch are durable;
    // the route surfaces a hard 500 so the operator sees the error
    // and audits the partial cleanup.
    mockCreateCustomerExclusion.mockResolvedValue(sampleRow);
    const pendingPredicate = {
      tableKey: "baselineTriagedEvent" as const,
      statements: [{ sql: "DELETE FROM baseline_triaged_event", params: [] }],
    };
    mockExecuteFirstBatch.mockResolvedValue({
      counts: {
        baselineTriagedEvent: 1,
        observedEventMeta: 0,
        policyTriagedEvent: null,
      },
      pending: [pendingPredicate],
    });
    mockDrainRemaining.mockRejectedValue(new Error("tenant DB blip"));
    mockGetCustomerPool.mockResolvedValue({ connect: vi.fn() });

    const { POST } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({ kind: "ipAddress", value: "10.0.0.0/24" }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error).toContain("tenant DB blip");
    expect(body.data).toEqual(sampleRow);
    // Audit row records the partial cleanup with drainStatus = 'failed'.
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage_exclusion.customer_add",
        details: expect.objectContaining({
          drainStatus: "failed",
          drainError: expect.stringContaining("tenant DB blip"),
        }),
      }),
    );
  });

  it("rejects an invalid kind via parseStoredExclusionInput", async () => {
    const { POST } = await import("@/app/api/triage/exclusions/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/exclusions?customer_id=42",
      {
        method: "POST",
        body: JSON.stringify({ kind: "bogus", value: "x" }),
      },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    expect(mockCreateCustomerExclusion).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});
