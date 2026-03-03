import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

describe("rate limiter", () => {
  let limiter: typeof import("@/lib/rate-limit/limiter");

  beforeEach(async () => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    limiter = await import("@/lib/rate-limit/limiter");
    limiter.resetRateLimiter();
  });

  afterEach(() => {
    limiter.resetRateLimiter();
  });

  // ── checkSignInRateLimit ─────────────────────────────────────

  describe("checkSignInRateLimit()", () => {
    it("passes when within all limits", async () => {
      const result = await limiter.checkSignInRateLimit("1.2.3.4", "alice");

      expect(result.limited).toBe(false);
    });

    it("blocks when per-IP limit is exceeded", async () => {
      // Default per-IP limit is 20 per 5 min
      for (let i = 0; i < 20; i++) {
        await limiter.checkSignInRateLimit("1.2.3.4");
      }

      const result = await limiter.checkSignInRateLimit("1.2.3.4");
      expect(result.limited).toBe(true);
      if (result.limited) {
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it("blocks when per-account+IP limit is exceeded", async () => {
      // Default per-account+IP limit is 5 per 5 min
      for (let i = 0; i < 5; i++) {
        await limiter.checkSignInRateLimit("1.2.3.4", "alice");
      }

      const result = await limiter.checkSignInRateLimit("1.2.3.4", "alice");
      expect(result.limited).toBe(true);
    });

    it("blocks when global limit is exceeded", async () => {
      // Default global limit is 100 per 1 min
      for (let i = 0; i < 100; i++) {
        await limiter.checkSignInRateLimit(`10.0.0.${i % 256}`);
      }

      const result = await limiter.checkSignInRateLimit("99.99.99.99");
      expect(result.limited).toBe(true);
    });

    it("skips per-account+IP check when username is absent", async () => {
      // Exhaust per-account+IP for alice from this IP
      for (let i = 0; i < 5; i++) {
        await limiter.checkSignInRateLimit("1.2.3.4", "alice");
      }

      // Without username, per-account+IP check is skipped, so should pass
      const result = await limiter.checkSignInRateLimit("1.2.3.4");
      expect(result.limited).toBe(false);
    });

    it("different IPs have independent per-IP counters", async () => {
      for (let i = 0; i < 20; i++) {
        await limiter.checkSignInRateLimit("1.2.3.4");
      }

      // Different IP should still pass
      const result = await limiter.checkSignInRateLimit("5.6.7.8");
      expect(result.limited).toBe(false);
    });

    it("different usernames have independent per-account+IP counters", async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.checkSignInRateLimit("1.2.3.4", "alice");
      }

      // Different username should still pass
      const result = await limiter.checkSignInRateLimit("1.2.3.4", "bob");
      expect(result.limited).toBe(false);
    });
  });

  // ── checkApiRateLimit ────────────────────────────────────────

  describe("checkApiRateLimit()", () => {
    it("passes when within limit", async () => {
      const result = await limiter.checkApiRateLimit("account-1");

      expect(result.limited).toBe(false);
    });

    it("blocks when per-user limit is exceeded", async () => {
      // Default per-user limit is 100 per 1 min
      for (let i = 0; i < 100; i++) {
        await limiter.checkApiRateLimit("account-1");
      }

      const result = await limiter.checkApiRateLimit("account-1");
      expect(result.limited).toBe(true);
      if (result.limited) {
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it("different accounts have independent counters", async () => {
      for (let i = 0; i < 100; i++) {
        await limiter.checkApiRateLimit("account-1");
      }

      const result = await limiter.checkApiRateLimit("account-2");
      expect(result.limited).toBe(false);
    });
  });

  // ── Config loading ───────────────────────────────────────────

  describe("config loading", () => {
    it("falls back to hardcoded defaults when DB query fails", async () => {
      mockPoolQuery.mockRejectedValue(new Error("DB down"));

      // Should still work with defaults (20 per-IP per 5 min)
      const result = await limiter.checkSignInRateLimit("1.2.3.4");
      expect(result.limited).toBe(false);
    });

    it("reads signin config from system_settings", async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            value: {
              per_ip_count: 2,
              per_ip_window_minutes: 1,
              per_account_ip_count: 1,
              per_account_ip_window_minutes: 1,
              global_count: 10,
              global_window_minutes: 1,
            },
          },
        ],
      });

      // With custom limit of 2 per-IP, 3rd request should be blocked
      await limiter.checkSignInRateLimit("1.2.3.4");
      await limiter.checkSignInRateLimit("1.2.3.4");
      const result = await limiter.checkSignInRateLimit("1.2.3.4");

      expect(result.limited).toBe(true);
    });

    it("reads api config from system_settings", async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            value: {
              per_user_count: 2,
              per_user_window_minutes: 1,
            },
          },
        ],
      });

      await limiter.checkApiRateLimit("account-1");
      await limiter.checkApiRateLimit("account-1");
      const result = await limiter.checkApiRateLimit("account-1");

      expect(result.limited).toBe(true);
    });

    it("caches config after first load", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await limiter.checkSignInRateLimit("1.2.3.4");
      await limiter.checkSignInRateLimit("1.2.3.4");

      // query should be called only once for config loading
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it("queries correct key for signin config", async () => {
      await limiter.checkSignInRateLimit("1.2.3.4");

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("system_settings"),
        ["signin_rate_limit"],
      );
    });

    it("queries correct key for api config", async () => {
      await limiter.checkApiRateLimit("account-1");

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("system_settings"),
        ["api_rate_limit"],
      );
    });
  });

  // ── resetRateLimiter ─────────────────────────────────────────

  describe("resetRateLimiter()", () => {
    it("clears cached config so next call re-queries DB", async () => {
      await limiter.checkSignInRateLimit("1.2.3.4");
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);

      limiter.resetRateLimiter();
      await limiter.checkSignInRateLimit("1.2.3.4");

      // Should have queried again after reset
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });
  });
});
