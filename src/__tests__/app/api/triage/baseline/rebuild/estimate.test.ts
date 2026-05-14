import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockGetCustomerPool = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: vi.fn((...args: unknown[]) =>
    mockResolveEffectiveCustomerIds(...args),
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

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

describe("GET /api/triage/baseline/rebuild/estimate", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockPoolQuery
      .mockReset()
      .mockResolvedValue({ rows: [{ count: "42" }], rowCount: 1 });
    mockGetCustomerPool.mockReset().mockResolvedValue({ query: mockPoolQuery });
    // Default: caller is single-customer-scoped to id 1 (the id used
    // by most of the success-path tests below).
    mockResolveEffectiveCustomerIds.mockReset().mockResolvedValue([1]);
  });

  it("returns 403 for non-SystemAdministrator", async () => {
    currentSession = { ...adminSession, roles: ["Security Administrator"] };
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=1&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing customerId", async () => {
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when from >= to", async () => {
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=1&from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns the COUNT(*) from baseline_triaged_event for [from, to)", async () => {
    // Use a recent `to` so the detector-retention warning does not fire
    // (the warning path is exercised by its own test below).
    const toIso = new Date(Date.now() - 60 * 1000).toISOString();
    const fromIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        `http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=1&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      ),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentTriagedRowCount).toBe(42);
    expect(body.warnings).toEqual([]);
    // SQL uses the byte-identical half-open predicate the POST's DELETE uses.
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("event_time >= $1 AND event_time < $2"),
      [fromIso, toIso],
    );
  });

  it("warns when `to` predates the detector store's retention horizon", async () => {
    // Force a small retention horizon so a recent `to` is past it.
    const original = process.env.REVIEW_DETECTOR_RETENTION_MS;
    process.env.REVIEW_DETECTOR_RETENTION_MS = "1000"; // 1 second
    try {
      const { GET } = await import(
        "@/app/api/triage/baseline/rebuild/estimate/route"
      );
      const res = await GET(
        makeRequest(
          "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=1&from=2025-01-01T00:00:00Z&to=2025-01-02T00:00:00Z",
        ),
        makeContext(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings[0]).toMatch(/detector store's data/);
    } finally {
      if (original === undefined) {
        delete process.env.REVIEW_DETECTOR_RETENTION_MS;
      } else {
        process.env.REVIEW_DETECTOR_RETENTION_MS = original;
      }
    }
  });

  it("returns 403 when the caller has no effective customer scope", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=42&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("Forbidden");
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("returns 400 RebuildValidation when caller's scope spans 2+ customers (access-all bypass blocked)", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2, 3]);
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=1&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RebuildValidation");
    expect(body.error).toMatch(/single-customer scope/i);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("returns 400 RebuildValidation when customerId does not match the caller's single tenant", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([7]);
    const { GET } = await import(
      "@/app/api/triage/baseline/rebuild/estimate/route"
    );
    const res = await GET(
      makeRequest(
        "http://localhost:3000/api/triage/baseline/rebuild/estimate?customerId=9&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
      ),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RebuildValidation");
    expect(body.error).toMatch(/does not match/i);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
