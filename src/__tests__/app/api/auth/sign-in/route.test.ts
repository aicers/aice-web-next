import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────

const mockQuery = vi.hoisted(() => vi.fn());
const mockCheckSignInRateLimit = vi.hoisted(() => vi.fn());
const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockIssueAccessToken = vi.hoisted(() => vi.fn());
const mockGenerateCsrfToken = vi.hoisted(() => vi.fn());
const mockSetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockIsIpAllowed = vi.hoisted(() => vi.fn());
const mockExtractClientIp = vi.hoisted(() => vi.fn());
const mockWithCorrelationId = vi.hoisted(() => vi.fn());
const mockGenerateCorrelationId = vi.hoisted(() => vi.fn());
const mockCookieSet = vi.hoisted(() => vi.fn());
const mockCookieDelete = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  checkSignInRateLimit: mockCheckSignInRateLimit,
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: mockVerifyPassword,
}));

vi.mock("@/lib/auth/jwt", () => ({
  issueAccessToken: mockIssueAccessToken,
}));

vi.mock("@/lib/auth/csrf", () => ({
  CSRF_COOKIE_NAME: "csrf",
  CSRF_COOKIE_OPTIONS: {
    httpOnly: false,
    secure: false,
    sameSite: "strict",
    path: "/",
  },
  generateCsrfToken: mockGenerateCsrfToken,
}));

vi.mock("@/lib/auth/cookies", () => ({
  setAccessTokenCookie: mockSetAccessTokenCookie,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

vi.mock("@/lib/auth/cidr", () => ({
  isIpAllowed: mockIsIpAllowed,
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: mockExtractClientIp,
}));

vi.mock("@/lib/audit/correlation", () => ({
  generateCorrelationId: mockGenerateCorrelationId,
  withCorrelationId: mockWithCorrelationId,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ set: mockCookieSet, delete: mockCookieDelete })),
}));

// ── Test data ──────────────────────────────────────────────────

const activeAccount = {
  id: "acc-1",
  password_hash: "$argon2id$hash",
  status: "active",
  token_version: 0,
  must_change_password: false,
  failed_sign_in_count: 0,
  locked_until: null,
  max_sessions: null,
  allowed_ips: null,
  role_name: "System Administrator",
};

const lockoutPolicy = {
  value: {
    stage1_threshold: 5,
    stage1_duration_minutes: 30,
    stage2_threshold: 3,
  },
};

// ── Helpers ────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────

describe("POST /api/auth/sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractClientIp.mockReturnValue("127.0.0.1");
    mockCheckSignInRateLimit.mockResolvedValue({ limited: false });
    mockIsIpAllowed.mockReturnValue(true);
    mockVerifyPassword.mockResolvedValue(true);
    mockIssueAccessToken.mockResolvedValue("jwt-token");
    mockGenerateCsrfToken.mockReturnValue({ token: "csrf-token" });
    mockSetAccessTokenCookie.mockResolvedValue(undefined);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGenerateCorrelationId.mockReturnValue("corr-id-1");
    mockWithCorrelationId.mockImplementation((_id: string, fn: () => unknown) =>
      fn(),
    );

    // Default: return active account
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM accounts")) {
        return { rows: [{ ...activeAccount }], rowCount: 1 };
      }
      if (sql.includes("system_settings") && sql.includes("lockout_policy")) {
        return { rows: [lockoutPolicy], rowCount: 1 };
      }
      if (sql.includes("system_settings") && sql.includes("session_policy")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sessions")) {
        return { rows: [{ sid: "sess-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    process.env.CSRF_SECRET = "test-csrf-secret";
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.CSRF_SECRET;
  });

  describe("body validation", () => {
    it("returns 400 for missing username", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(makeRequest({ password: "pass" }));
      expect(response.status).toBe(400);
    });

    it("returns 400 for missing password", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(makeRequest({ username: "admin" }));
      expect(response.status).toBe(400);
    });

    it("returns 400 for empty body", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(makeRequest({}));
      expect(response.status).toBe(400);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 when rate limited", async () => {
      mockCheckSignInRateLimit.mockResolvedValue({
        limited: true,
        retryAfterSeconds: 42,
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("42");
    });

    it("records audit on rate limit", async () => {
      mockCheckSignInRateLimit.mockResolvedValue({
        limited: true,
        retryAfterSeconds: 10,
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.sign_in.failure",
          details: expect.objectContaining({ reason: "rate_limited" }),
        }),
      );
    });
  });

  describe("account lookup", () => {
    it("returns 401 when account not found", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "unknown", password: "pass" }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("lockout", () => {
    it("returns 403 when account is permanently locked", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, status: "locked", locked_until: null }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Account is locked");
      expect(body.code).toBe("ACCOUNT_LOCKED");
    });

    it("returns 403 when temporary lock has not expired", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                status: "locked",
                locked_until: future,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(403);
    });

    it("auto-unlocks expired temporary lock and proceeds", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                status: "locked",
                locked_until: past,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("SET status = 'active'")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO sessions")) {
          return { rows: [{ sid: "sess-1" }], rowCount: 1 };
        }
        if (sql.includes("failed_sign_in_count = 0")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(200);
    });

    it("returns 403 for inactive account (suspended)", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, status: "suspended" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Account is not active");
      expect(body.code).toBe("ACCOUNT_INACTIVE");
    });
  });

  describe("CIDR check", () => {
    it("returns 403 when IP not in allowed_ips", async () => {
      mockIsIpAllowed.mockReturnValue(false);

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Access denied from this network");
      expect(body.code).toBe("IP_RESTRICTED");
    });
  });

  describe("password verification", () => {
    it("returns 401 when password is wrong", async () => {
      mockVerifyPassword.mockResolvedValue(false);

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "wrong" }),
      );

      expect(response.status).toBe(401);
    });

    it("increments failed_sign_in_count on wrong password", async () => {
      mockVerifyPassword.mockResolvedValue(false);

      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "wrong" }));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("failed_sign_in_count"),
        expect.arrayContaining([1]),
      );
    });

    it("triggers stage1 lock at threshold", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, failed_sign_in_count: 4 }],
            rowCount: 1,
          };
        }
        if (sql.includes("system_settings")) {
          return { rows: [lockoutPolicy], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "wrong" }));

      // Should lock with temporary duration (count reaches 5 = stage1_threshold)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'locked'"),
        expect.arrayContaining([5, 30]),
      );
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ action: "account.lock" }),
      );
    });

    it("triggers stage2 permanent lock", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, failed_sign_in_count: 7 }],
            rowCount: 1,
          };
        }
        if (sql.includes("system_settings")) {
          return { rows: [lockoutPolicy], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "wrong" }));

      // Count reaches 8 = 5 + 3 = stage1 + stage2 threshold
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("locked_until = NULL"),
        expect.arrayContaining([8]),
      );
    });
  });

  describe("max sessions", () => {
    it("returns 403 when max sessions exceeded", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, max_sessions: 2 }],
            rowCount: 1,
          };
        }
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "2" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(403);
    });
  });

  describe("success", () => {
    it("returns 200 with mustChangePassword", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.mustChangePassword).toBe(false);
    });

    it("returns mustChangePassword true when set", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [{ ...activeAccount, must_change_password: true }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO sessions")) {
          return { rows: [{ sid: "sess-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "pass" }),
      );

      const body = await response.json();
      expect(body.mustChangePassword).toBe(true);
    });

    it("creates a session record", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sessions"),
        expect.arrayContaining(["acc-1", "127.0.0.1"]),
      );
    });

    it("sets JWT and CSRF cookies", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockSetAccessTokenCookie).toHaveBeenCalledWith("jwt-token", 900);
      expect(mockCookieSet).toHaveBeenCalledWith(
        "csrf",
        "csrf-token",
        expect.objectContaining({ maxAge: 900 }),
      );
    });

    it("records audit success", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.sign_in.success",
          target: "session",
        }),
      );
    });

    it("resets failed_sign_in_count on success", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("failed_sign_in_count = 0"),
        ["acc-1"],
      );
    });

    it("wraps handler in withCorrelationId", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockGenerateCorrelationId).toHaveBeenCalledTimes(1);
      expect(mockWithCorrelationId).toHaveBeenCalledWith(
        "corr-id-1",
        expect.any(Function),
      );
    });
  });
});
