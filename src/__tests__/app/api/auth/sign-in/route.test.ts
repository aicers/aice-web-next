import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────

const mockQuery = vi.hoisted(() => vi.fn());
const mockCheckSignInRateLimit = vi.hoisted(() => vi.fn());
const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockIssueAccessToken = vi.hoisted(() => vi.fn());
const mockGenerateCsrfToken = vi.hoisted(() => vi.fn());
const mockSetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockSetTokenExpCookie = vi.hoisted(() => vi.fn());
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
  setTokenExpCookie: mockSetTokenExpCookie,
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
  lockout_count: 0,
  locked_until: null,
  max_sessions: null,
  allowed_ips: null,
  role_name: "System Administrator",
};

const lockoutPolicy = {
  value: {
    stage1_threshold: 5,
    stage1_duration_minutes: 30,
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

    it("auto-unlock preserves lockout_count", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                status: "locked",
                locked_until: past,
                lockout_count: 1,
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
      await POST(makeRequest({ username: "admin", password: "pass" }));

      // Auto-unlock UPDATE should NOT reset lockout_count
      const autoUnlockCall = mockQuery.mock.calls.find(
        (args: unknown[]) =>
          typeof args[0] === "string" &&
          args[0].includes("SET status = 'active'") &&
          args[0].includes("failed_sign_in_count = 0"),
      );
      expect(autoUnlockCall).toBeDefined();
      expect(autoUnlockCall?.[0]).not.toContain("lockout_count");
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

      // Should lock with temporary duration and increment lockout_count
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'locked'"),
        expect.arrayContaining([5, 30]),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("lockout_count = lockout_count + 1"),
        expect.arrayContaining([5, 30]),
      );
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ action: "account.lock" }),
      );
    });

    it("triggers stage2 suspension when lockout_count >= 1", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                failed_sign_in_count: 4,
                lockout_count: 1,
              },
            ],
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

      // Should suspend (not lock) when lockout_count >= 1
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'suspended'"),
        expect.arrayContaining([5]),
      );
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ action: "account.suspend" }),
      );
    });

    it("triggers stage2 suspension with lockout_count > 1", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                failed_sign_in_count: 4,
                lockout_count: 3,
              },
            ],
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

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'suspended'"),
        expect.arrayContaining([5]),
      );
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "account.suspend",
          details: expect.objectContaining({ lockoutCount: 3 }),
        }),
      );
    });

    it("stage1 lock does not suspend when lockout_count is 0", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                failed_sign_in_count: 4,
                lockout_count: 0,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("system_settings")) {
          return { rows: [lockoutPolicy], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "wrong" }),
      );

      expect(response.status).toBe(401);

      // Should lock, NOT suspend
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'locked'"),
        expect.arrayContaining([5, 30]),
      );
      expect(mockQuery).not.toHaveBeenCalledWith(
        expect.stringContaining("status = 'suspended'"),
        expect.anything(),
      );
    });

    it("returns 401 for wrong password during stage2 suspension", async () => {
      mockVerifyPassword.mockResolvedValue(false);
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) {
          return {
            rows: [
              {
                ...activeAccount,
                failed_sign_in_count: 4,
                lockout_count: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("system_settings")) {
          return { rows: [lockoutPolicy], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const { POST } = await import("@/app/api/auth/sign-in/route");
      const response = await POST(
        makeRequest({ username: "admin", password: "wrong" }),
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.code).toBe("INVALID_CREDENTIALS");
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

    it("sets token_exp cookie with expiry timestamp", async () => {
      const before = Math.floor(Date.now() / 1000) + 900;
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));
      const after = Math.floor(Date.now() / 1000) + 900;

      expect(mockSetTokenExpCookie).toHaveBeenCalledTimes(1);
      const [expArg, maxAgeArg] = mockSetTokenExpCookie.mock.calls[0];
      expect(expArg).toBeGreaterThanOrEqual(before);
      expect(expArg).toBeLessThanOrEqual(after);
      expect(maxAgeArg).toBe(900);
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

    it("resets failed_sign_in_count and lockout_count on success", async () => {
      const { POST } = await import("@/app/api/auth/sign-in/route");
      await POST(makeRequest({ username: "admin", password: "pass" }));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("failed_sign_in_count = 0"),
        ["acc-1"],
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("lockout_count = 0"),
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
