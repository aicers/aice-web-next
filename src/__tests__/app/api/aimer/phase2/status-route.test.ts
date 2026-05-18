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

const mockIsSystemAdministrator = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/role-guard", () => ({
  isSystemAdministrator: mockIsSystemAdministrator,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockBuildStatus = vi.hoisted(() => vi.fn());
const mockBuildSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/status", () => ({
  buildPhase2StatusDto: mockBuildStatus,
  buildPhase2StatusSummary: mockBuildSummary,
}));

const mockDbQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({
  query: mockDbQuery,
}));

const now = Math.floor(Date.now() / 1000);
function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
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
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({}) };

describe("GET /api/aimer/phase2/status", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockBuildStatus.mockReset().mockResolvedValue({
      customer_id: 42,
      streaming: [],
      policy_run: {
        kind: "policy_run",
        last_sent_run_id: null,
        last_sent_at: null,
        last_sent_by: null,
        total_runs_sent: 0,
      },
      policy_event: {
        kind: "policy_event",
        pending_notice_count: 0,
        last_error: null,
      },
    });
  });

  it("returns 403 when the session is not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { GET } = await import("@/app/api/aimer/phase2/status/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/aimer/phase2/status?customer_id=42",
      ),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(mockBuildStatus).not.toHaveBeenCalled();
  });

  it("returns 400 when customer_id is missing or non-positive", async () => {
    const { GET } = await import("@/app/api/aimer/phase2/status/route");
    const res = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status"),
      ctx,
    );
    expect(res.status).toBe(400);
    const res2 = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status?customer_id=0"),
      ctx,
    );
    expect(res2.status).toBe(400);
  });

  it("returns 404 when the customer is outside the caller's scope", async () => {
    mockResolveScope.mockResolvedValueOnce([1, 2, 3]);
    const { GET } = await import("@/app/api/aimer/phase2/status/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/aimer/phase2/status?customer_id=42",
      ),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(mockBuildStatus).not.toHaveBeenCalled();
  });

  it("returns the per-customer DTO on success", async () => {
    const { GET } = await import("@/app/api/aimer/phase2/status/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/aimer/phase2/status?customer_id=42",
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer_id).toBe(42);
    expect(mockBuildStatus).toHaveBeenCalledWith(42);
  });
});

describe("GET /api/aimer/phase2/status/summary", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([1, 2, 3]);
    mockBuildSummary.mockReset().mockResolvedValue({ customers: [] });
    // Default: all scope customers are active.
    mockDbQuery
      .mockReset()
      .mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { GET } = await import("@/app/api/aimer/phase2/status/summary/route");
    const res = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status/summary"),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(mockBuildSummary).not.toHaveBeenCalled();
  });

  it("returns an empty list when no customers are flagged", async () => {
    const { GET } = await import("@/app/api/aimer/phase2/status/summary/route");
    const res = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status/summary"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers).toEqual([]);
    expect(mockBuildSummary).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("filters out non-active customers before invoking the summary builder", async () => {
    // Effective scope contains a suspended customer (id 3); the active
    // filter strips it so the banner cannot warn about a tenant that is
    // hidden from the Settings page picker.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    const { GET } = await import("@/app/api/aimer/phase2/status/summary/route");
    const res = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status/summary"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockBuildSummary).toHaveBeenCalledWith([1, 2]);
  });

  it("threads the flagged-customer list through to the response", async () => {
    mockBuildSummary.mockResolvedValueOnce({
      customers: [
        {
          customer_id: 2,
          worst_bucket: "way_behind",
          kinds: ["baseline_event"],
        },
      ],
    });
    const { GET } = await import("@/app/api/aimer/phase2/status/summary/route");
    const res = await GET(
      new NextRequest("http://localhost/api/aimer/phase2/status/summary"),
      ctx,
    );
    const body = await res.json();
    expect(body.customers[0].customer_id).toBe(2);
    expect(body.customers[0].worst_bucket).toBe("way_behind");
  });
});
