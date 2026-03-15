import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  invalidateRateLimitConfig: vi.fn(),
}));

vi.mock("@/lib/auth/password-policy", () => ({
  invalidatePasswordPolicy: vi.fn(),
}));

vi.mock("@/lib/auth/session-policy", () => ({
  invalidateSessionPolicy: vi.fn(),
}));

vi.mock("@/lib/auth/lockout-policy", () => ({
  invalidateLockoutPolicy: vi.fn(),
}));

vi.mock("@/lib/auth/jwt-policy", () => ({
  invalidateJwtPolicy: vi.fn(),
}));

vi.mock("@/lib/auth/mfa-policy", () => ({
  invalidateMfaPolicy: vi.fn(),
}));

import { query } from "@/lib/db/client";

const queryMock = vi.mocked(query);

describe("system-settings", () => {
  let mod: typeof import("@/lib/auth/system-settings");

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("@/lib/auth/system-settings");
    queryMock.mockClear();
  });

  // ── validateSetting ───────────────────────────────────────────

  describe("validateSetting", () => {
    it("rejects unknown keys", () => {
      const result = mod.validateSetting("unknown_key", {});
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/Unknown setting key/);
    });

    it("rejects non-object values", () => {
      const result = mod.validateSetting("password_policy", "string");
      expect(result.valid).toBe(false);
    });

    it("validates password_policy correctly", () => {
      const valid = mod.validateSetting("password_policy", {
        min_length: 12,
        max_length: 128,
        complexity_enabled: false,
        reuse_ban_count: 5,
      });
      expect(valid.valid).toBe(true);

      const invalid = mod.validateSetting("password_policy", {
        min_length: 3,
        max_length: 128,
        complexity_enabled: false,
        reuse_ban_count: 5,
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors?.[0]).toMatch(/min_length/);
    });

    it("validates max_length >= min_length", () => {
      const result = mod.validateSetting("password_policy", {
        min_length: 50,
        max_length: 30,
        complexity_enabled: false,
        reuse_ban_count: 5,
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("max_length"))).toBe(true);
    });

    it("validates session_policy correctly", () => {
      const valid = mod.validateSetting("session_policy", {
        idle_timeout_minutes: 30,
        absolute_timeout_hours: 8,
        max_sessions: null,
      });
      expect(valid.valid).toBe(true);

      const withMax = mod.validateSetting("session_policy", {
        idle_timeout_minutes: 30,
        absolute_timeout_hours: 8,
        max_sessions: 5,
      });
      expect(withMax.valid).toBe(true);
    });

    it("validates lockout_policy correctly", () => {
      const valid = mod.validateSetting("lockout_policy", {
        stage1_threshold: 5,
        stage1_duration_minutes: 30,
      });
      expect(valid.valid).toBe(true);

      const invalid = mod.validateSetting("lockout_policy", {
        stage1_threshold: 0,
        stage1_duration_minutes: 30,
      });
      expect(invalid.valid).toBe(false);
    });

    it("validates jwt_policy correctly", () => {
      const valid = mod.validateSetting("jwt_policy", {
        access_token_expiration_minutes: 15,
      });
      expect(valid.valid).toBe(true);

      const invalid = mod.validateSetting("jwt_policy", {
        access_token_expiration_minutes: 0,
      });
      expect(invalid.valid).toBe(false);
    });

    it("validates mfa_policy correctly", () => {
      const valid = mod.validateSetting("mfa_policy", {
        allowed_methods: ["webauthn", "totp"],
      });
      expect(valid.valid).toBe(true);

      const empty = mod.validateSetting("mfa_policy", {
        allowed_methods: [],
      });
      expect(empty.valid).toBe(false);

      const invalid = mod.validateSetting("mfa_policy", {
        allowed_methods: ["sms"],
      });
      expect(invalid.valid).toBe(false);
    });

    it("validates signin_rate_limit correctly", () => {
      const valid = mod.validateSetting("signin_rate_limit", {
        per_ip_count: 20,
        per_ip_window_minutes: 5,
        per_account_ip_count: 5,
        per_account_ip_window_minutes: 5,
        global_count: 100,
        global_window_minutes: 1,
      });
      expect(valid.valid).toBe(true);
    });

    it("validates api_rate_limit correctly", () => {
      const valid = mod.validateSetting("api_rate_limit", {
        per_user_count: 100,
        per_user_window_minutes: 1,
      });
      expect(valid.valid).toBe(true);
    });
  });

  // ── getSystemSettings ─────────────────────────────────────────

  describe("getSystemSettings", () => {
    it("returns all settings", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            key: "jwt_policy",
            value: { access_token_expiration_minutes: 15 },
            updated_at: "2025-01-01",
          },
          {
            key: "password_policy",
            value: { min_length: 12 },
            updated_at: "2025-01-01",
          },
        ],
        rowCount: 2,
      });

      const result = await mod.getSystemSettings();
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe("jwt_policy");
    });
  });

  // ── updateSystemSetting ───────────────────────────────────────

  describe("updateSystemSetting", () => {
    it("returns validation errors for invalid value", async () => {
      const result = await mod.updateSystemSetting("password_policy", {
        min_length: 3,
        max_length: 128,
        complexity_enabled: false,
        reuse_ban_count: 5,
      });
      expect(result.valid).toBe(false);
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("updates and invalidates cache on success", async () => {
      const { invalidatePasswordPolicy } = await import(
        "@/lib/auth/password-policy"
      );

      queryMock.mockResolvedValueOnce({
        rows: [
          {
            key: "password_policy",
            value: {
              min_length: 16,
              max_length: 128,
              complexity_enabled: true,
              reuse_ban_count: 5,
            },
            updated_at: "2025-01-01",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.updateSystemSetting("password_policy", {
        min_length: 16,
        max_length: 128,
        complexity_enabled: true,
        reuse_ban_count: 5,
      });

      expect(result.valid).toBe(true);
      expect(result.data?.key).toBe("password_policy");
      expect(invalidatePasswordPolicy).toHaveBeenCalled();
    });

    it("returns error when setting not found in DB", async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await mod.updateSystemSetting("jwt_policy", {
        access_token_expiration_minutes: 15,
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not found/);
    });
  });
});
