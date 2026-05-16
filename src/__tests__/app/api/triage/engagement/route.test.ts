import { NextRequest, NextResponse } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
const mockQuery = vi.hoisted(() => vi.fn());
const mockRecordImpressions = vi.hoisted(() => vi.fn());
const mockRecordAction = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/triage/engagement/storage", () => ({
  recordImpressions: vi.fn((...args: unknown[]) =>
    mockRecordImpressions(...args),
  ),
  recordAction: vi.fn((...args: unknown[]) => mockRecordAction(...args)),
}));

const TEST_KEY = "x".repeat(64);
const ORIGINAL_KEY = process.env.ENGAGEMENT_HMAC_KEY;

const now = Math.floor(Date.now() / 1000);
const baseSession: AuthSession = {
  accountId: "alice",
  sessionId: "session-1",
  roles: ["Triage Analyst"],
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

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/triage/engagement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
});

function setPermissions(opts: { triageRead?: boolean; accessAll?: boolean }) {
  mockHasPermission.mockImplementation(
    async (_roles: string[], perm: string) => {
      if (perm === "triage:read") return opts.triageRead ?? true;
      if (perm === "customers:access-all") return opts.accessAll ?? false;
      return false;
    },
  );
}

beforeEach(() => {
  currentSession = baseSession;
  mockHasPermission.mockReset();
  setPermissions({ triageRead: true, accessAll: false });
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockRecordImpressions.mockReset().mockResolvedValue(1);
  mockRecordAction.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ENGAGEMENT_HMAC_KEY;
  } else {
    process.env.ENGAGEMENT_HMAC_KEY = ORIGINAL_KEY;
  }
});

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function impressionBatchBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "impressions",
    customerId: 42,
    menuLoadId: VALID_UUID,
    strictnessStop: "top50",
    surface: "baseline",
    periodStartIso: "2026-05-09T00:00:00.000Z",
    periodEndIso: "2026-05-16T00:00:00.000Z",
    impressions: [
      {
        eventKey: "evt-1",
        kind: "HttpThreat",
        slotBucket: "HttpThreat:false",
        rank: 1,
        baselineVersion: "phase1b-four-selector",
        shownBy: "quota",
      },
    ],
    ...overrides,
  };
}

describe("POST /api/triage/engagement", () => {
  it("returns 400 when the body is not valid JSON", async () => {
    const { POST } = await import("@/app/api/triage/engagement/route");
    const request = new NextRequest(
      "http://localhost:3000/api/triage/engagement",
      { method: "POST", body: "not-json" },
    );
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("returns 400 when `kind` is missing", async () => {
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(jsonRequest({}), makeContext());
    expect(response.status).toBe(400);
  });

  it("returns 400 on an unknown `kind`", async () => {
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest({ kind: "made-up" }),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 on a malformed impression batch", async () => {
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest(impressionBatchBody({ menuLoadId: "not-a-uuid" })),
      makeContext(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 403 when the caller has no scope for the customer", async () => {
    // No customers:access-all permission; account_customer SELECT returns 0 rows.
    setPermissions({ triageRead: true, accessAll: false });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest(impressionBatchBody()),
      makeContext(),
    );
    expect(response.status).toBe(403);
    expect(mockRecordImpressions).not.toHaveBeenCalled();
  });

  it("writes an impression batch for an access-all caller", async () => {
    setPermissions({ triageRead: true, accessAll: true });
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest(impressionBatchBody()),
      makeContext(),
    );
    expect(response.status).toBe(202);
    expect(mockRecordImpressions).toHaveBeenCalledTimes(1);
    const [accountHmac, batch] = mockRecordImpressions.mock.calls[0];
    // account_id is sent HMAC'd, never raw.
    expect(accountHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(accountHmac).not.toBe("alice");
    expect(batch.customerId).toBe(42);
    expect(batch.impressions).toHaveLength(1);
  });

  it("writes an action for an access-all caller", async () => {
    setPermissions({ triageRead: true, accessAll: true });
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest({
        kind: "action",
        action: {
          type: "strictness_change",
          customerId: 42,
          surface: "baseline",
          strictnessFrom: "top50",
          strictnessTo: "top20",
        },
      }),
      makeContext(),
    );
    expect(response.status).toBe(202);
    expect(mockRecordAction).toHaveBeenCalledTimes(1);
  });

  it("rejects exclusion_create via the HTTP endpoint with 400", async () => {
    setPermissions({ triageRead: true, accessAll: true });
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest({
        kind: "action",
        action: {
          type: "exclusion_create",
          customerId: 42,
          surface: "baseline",
          exclusionId: "excl-1",
        },
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    expect(mockRecordAction).not.toHaveBeenCalled();
  });

  it("returns 500 when the storage layer fails (drop to the structured log)", async () => {
    setPermissions({ triageRead: true, accessAll: true });
    mockRecordImpressions.mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest(impressionBatchBody()),
      makeContext(),
    );
    expect(response.status).toBe(500);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("grants scope via account_customer when not access-all", async () => {
    setPermissions({ triageRead: true, accessAll: false });
    mockQuery.mockResolvedValue({ rows: [{ customer_id: 42 }], rowCount: 1 });
    const { POST } = await import("@/app/api/triage/engagement/route");
    const response = await POST(
      jsonRequest(impressionBatchBody()),
      makeContext(),
    );
    expect(response.status).toBe(202);
    expect(mockRecordImpressions).toHaveBeenCalledTimes(1);
  });
});
