import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockQueryAudit = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (request: NextRequest, context: unknown) => {
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

vi.mock("@/lib/audit/client", () => ({
  queryAudit: vi.fn((...args: unknown[]) => mockQueryAudit(...args)),
}));

describe("GET /api/audit-logs", () => {
  const now = Math.floor(Date.now() / 1000);

  const adminSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  const viewerSession: AuthSession = {
    ...adminSession,
    roles: ["viewer"],
  };

  function makeRequest(params = "") {
    return new NextRequest(
      `http://localhost:3000/api/audit-logs${params ? `?${params}` : ""}`,
    );
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(() => {
    mockQueryAudit.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;

    // Default: COUNT returns 0, data returns empty
    mockQueryAudit.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 1 });
  });

  // ── Permission ──────────────────────────────────────────────────

  describe("permission", () => {
    it("returns 403 when user lacks System Administrator role", async () => {
      currentSession = viewerSession;
      mockHasPermission.mockResolvedValue(false);
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Forbidden");
    });

    it("allows access for System Administrator", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest(), makeContext());

      expect(response.status).toBe(200);
    });
  });

  // ── Pagination ──────────────────────────────────────────────────

  describe("pagination", () => {
    it("defaults to page=1, pageSize=20", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest(), makeContext());
      const body = await response.json();

      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
    });

    it("respects custom page and pageSize", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "50" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(
        makeRequest("page=3&pageSize=10"),
        makeContext(),
      );
      const body = await response.json();

      expect(body.page).toBe(3);
      expect(body.pageSize).toBe(10);
    });

    it("clamps pageSize to 100", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest("pageSize=500"), makeContext());
      const body = await response.json();

      expect(body.pageSize).toBe(100);
    });

    it("clamps page to minimum of 1", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest("page=-5"), makeContext());
      const body = await response.json();

      expect(body.page).toBe(1);
    });
  });

  // ── Validation ──────────────────────────────────────────────────

  describe("validation", () => {
    it("returns 400 for invalid from date", async () => {
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest("from=not-a-date"), makeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid 'from' date");
    });

    it("returns 400 for invalid to date", async () => {
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest("to=not-a-date"), makeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid 'to' date");
    });

    it("returns 400 for invalid action type", async () => {
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(
        makeRequest("action=invalid.action"),
        makeContext(),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid action type");
    });

    it("returns 400 for invalid target type", async () => {
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(
        makeRequest("targetType=unknown"),
        makeContext(),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid target type");
    });

    it("returns 400 for non-UUID correlationId", async () => {
      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(
        makeRequest("correlationId=not-a-uuid"),
        makeContext(),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid correlation ID format");
    });
  });

  // ── Query building ──────────────────────────────────────────────

  describe("query building", () => {
    it("passes no WHERE conditions when no filters", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      await GET(makeRequest(), makeContext());

      // COUNT query — no WHERE
      expect(mockQueryAudit).toHaveBeenCalledWith(
        expect.stringContaining("SELECT COUNT(*)"),
        [],
      );
    });

    it("applies actor filter", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      await GET(makeRequest("actor=alice"), makeContext());

      expect(mockQueryAudit).toHaveBeenCalledWith(
        expect.stringContaining("actor_id = $1"),
        ["alice"],
      );
    });

    it("applies action filter", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      await GET(makeRequest("action=auth.sign_in.success"), makeContext());

      expect(mockQueryAudit).toHaveBeenCalledWith(
        expect.stringContaining("action = $1"),
        ["auth.sign_in.success"],
      );
    });

    it("accepts session actions that the UI exposes", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(
        makeRequest("action=session.reauth_required"),
        makeContext(),
      );

      expect(response.status).toBe(200);
      expect(mockQueryAudit).toHaveBeenCalledWith(
        expect.stringContaining("action = $1"),
        ["session.reauth_required"],
      );
    });

    it("applies correlation ID filter", async () => {
      const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      await GET(makeRequest(`correlationId=${uuid}`), makeContext());

      expect(mockQueryAudit).toHaveBeenCalledWith(
        expect.stringContaining("correlation_id = $1"),
        [uuid],
      );
    });

    it("combines multiple filters with AND", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { GET } = await import("@/app/api/audit-logs/route");
      await GET(
        makeRequest("actor=alice&action=auth.sign_out&targetType=session"),
        makeContext(),
      );

      // COUNT query should have all three conditions
      const countCall = mockQueryAudit.mock.calls[0];
      expect(countCall[0]).toContain("actor_id = $1");
      expect(countCall[0]).toContain("action = $2");
      expect(countCall[0]).toContain("target_type = $3");
      expect(countCall[1]).toEqual(["alice", "auth.sign_out", "session"]);
    });
  });

  // ── Response ────────────────────────────────────────────────────

  describe("response", () => {
    it("returns { data, total, page, pageSize } structure", async () => {
      const sampleRow = {
        id: "1",
        timestamp: "2026-03-01T00:00:00Z",
        actor_id: "account-1",
        action: "auth.sign_in.success",
        target_type: "account",
        target_id: "account-1",
        details: null,
        ip_address: "1.2.3.4",
        sid: "session-1",
        customer_id: null,
        correlation_id: null,
      };

      mockQueryAudit
        .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [sampleRow], rowCount: 1 });

      const { GET } = await import("@/app/api/audit-logs/route");
      const response = await GET(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.data[0].action).toBe("auth.sign_in.success");
    });
  });
});
