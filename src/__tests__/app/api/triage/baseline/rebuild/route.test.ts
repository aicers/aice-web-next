import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockRunRebuild = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;

vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn) => {
    return async (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> },
    ) => handler(request, context, currentSession);
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

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: vi.fn((...args: unknown[]) =>
    mockResolveEffectiveCustomerIds(...args),
  ),
}));

vi.mock("@/lib/triage/baseline/rebuild", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/baseline/rebuild")
  >("@/lib/triage/baseline/rebuild");
  return {
    ...actual,
    runTriageBaselineRebuild: vi.fn((...args: unknown[]) =>
      mockRunRebuild(...args),
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

const nonAdminSession: AuthSession = {
  ...adminSession,
  accountId: "user-1",
  roles: ["Security Administrator"],
};

function makeContext() {
  return { params: Promise.resolve({}) };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/triage/baseline/rebuild", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/triage/baseline/rebuild", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditRecord.mockReset();
    mockRunRebuild.mockReset();
    // Default: caller is single-customer-scoped to id 42 (matching the
    // request body used by most success-path tests below). Tests that
    // exercise the scope-mismatch / multi-customer / empty-scope paths
    // override this per-test.
    mockResolveEffectiveCustomerIds.mockReset().mockResolvedValue([42]);
  });

  it("returns 403 when caller is not SystemAdministrator", async () => {
    currentSession = nonAdminSession;
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 1,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("Forbidden");
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 for from == to", async () => {
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 1,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RebuildValidation");
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 for from > to", async () => {
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 1,
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid customerId", async () => {
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 0,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller has no effective customer scope", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("Forbidden");
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 RebuildValidation when caller's scope spans 2+ customers (access-all bypass blocked)", async () => {
    // A System Administrator with customers:access-all has all
    // tenants in their effective scope. The UI hides the button in
    // this case; the server must enforce the same gate or the access-
    // all admin could rebuild an arbitrary tenant by POSTing its id.
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99, 100]);
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RebuildValidation");
    expect(body.error).toMatch(/single-customer scope/i);
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 RebuildValidation when customerId does not match the caller's single tenant", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 99,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RebuildValidation");
    expect(body.error).toMatch(/does not match/i);
    expect(mockRunRebuild).not.toHaveBeenCalled();
  });

  it("invokes the runner and emits an audit row on success", async () => {
    mockRunRebuild.mockResolvedValue({
      deletedTriagedRows: 10,
      deletedObservedRows: 12,
      insertedTriagedRows: 8,
      insertedObservedRows: 10,
      durationMs: 1234,
      startedAtIso: "2026-05-09T11:00:00.000Z",
      completedAtIso: "2026-05-09T11:00:01.234Z",
      warnings: [],
    });
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletedTriagedRows).toBe(10);
    expect(body.insertedTriagedRows).toBe(8);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "triage_baseline.rebuild",
        target: "customer",
        targetId: "42",
        customerId: 42,
        details: expect.objectContaining({
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
          deletedTriagedRows: 10,
          deletedObservedRows: 12,
          insertedTriagedRows: 8,
          insertedObservedRows: 10,
          durationMs: 1234,
          // #473 §6 lists `started_at` and `completed_at` in the audit
          // payload — assert both timestamps round-trip into the
          // details block so the audit row is a complete record of
          // the rebuild window, not just its duration.
          startedAt: "2026-05-09T11:00:00.000Z",
          completedAt: "2026-05-09T11:00:01.234Z",
        }),
      }),
    );
  });

  it("maps RebuildBusyError to HTTP 409", async () => {
    const { RebuildBusyError } = await import("@/lib/triage/baseline/rebuild");
    mockRunRebuild.mockRejectedValue(new RebuildBusyError());
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("RebuildBusy");
  });

  it("maps RebuildTimeoutError to HTTP 504", async () => {
    const { RebuildTimeoutError } = await import(
      "@/lib/triage/baseline/rebuild"
    );
    mockRunRebuild.mockRejectedValue(new RebuildTimeoutError());
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("RebuildTimeout");
  });

  it("appends a warning when the audit write fails (operation still 200)", async () => {
    mockRunRebuild.mockResolvedValue({
      deletedTriagedRows: 3,
      deletedObservedRows: 4,
      insertedTriagedRows: 2,
      insertedObservedRows: 5,
      durationMs: 1,
      startedAtIso: "2026-05-09T11:00:00.000Z",
      completedAtIso: "2026-05-09T11:00:00.001Z",
      warnings: [],
    });
    mockAuditRecord.mockRejectedValue(new Error("audit_db unavailable"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/triage/baseline/rebuild/route");
    const res = await POST(
      makeRequest({
        customerId: 42,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toContain(
      "audit log write failed; see app log for fallback record",
    );
    // Fallback log is the secondary persistent record when audit_db is
    // unreachable; assert it carries the same timestamps and the full
    // count set the audit row would have, so the structured log line
    // is a drop-in equivalent.
    expect(consoleSpy).toHaveBeenCalledWith(
      "[triage_baseline.rebuild] audit log write failed:",
      "audit_db unavailable",
      expect.objectContaining({
        actor: "admin-1",
        customerId: 42,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        startedAt: "2026-05-09T11:00:00.000Z",
        completedAt: "2026-05-09T11:00:00.001Z",
        deletedTriagedRows: 3,
        deletedObservedRows: 4,
        insertedTriagedRows: 2,
        insertedObservedRows: 5,
        durationMs: 1,
      }),
    );
    consoleSpy.mockRestore();
  });
});
