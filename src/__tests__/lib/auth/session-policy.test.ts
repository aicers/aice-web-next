import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

describe("session-policy", () => {
  let mod: typeof import("@/lib/auth/session-policy");

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    delete process.env.SESSION_IDLE_TIMEOUT_MINUTES;
    delete process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS;
    delete process.env.SESSION_MAX_SESSIONS;
    mod = await import("@/lib/auth/session-policy");
    mod.invalidateSessionPolicy();
  });

  afterEach(() => {
    delete process.env.SESSION_IDLE_TIMEOUT_MINUTES;
    delete process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS;
    delete process.env.SESSION_MAX_SESSIONS;
  });

  // ── loadSessionPolicy ──────────────────────────────────────────

  describe("loadSessionPolicy", () => {
    it("returns hardcoded defaults when DB query fails", async () => {
      mockPoolQuery.mockRejectedValue(new Error("connection refused"));

      const policy = await mod.loadSessionPolicy();

      expect(policy).toEqual({
        idleTimeoutMinutes: 30,
        absoluteTimeoutHours: 8,
        maxSessions: null,
      });
    });

    it("returns hardcoded defaults when no row is found", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      const policy = await mod.loadSessionPolicy();

      expect(policy).toEqual({
        idleTimeoutMinutes: 30,
        absoluteTimeoutHours: 8,
        maxSessions: null,
      });
    });

    it("returns DB values when available", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          {
            value: {
              idle_timeout_minutes: 15,
              absolute_timeout_hours: 4,
              max_sessions: 3,
            },
          },
        ],
      });

      const policy = await mod.loadSessionPolicy();

      expect(policy).toEqual({
        idleTimeoutMinutes: 15,
        absoluteTimeoutHours: 4,
        maxSessions: 3,
      });
    });

    it("env vars override DB values", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          {
            value: {
              idle_timeout_minutes: 15,
              absolute_timeout_hours: 4,
              max_sessions: 3,
            },
          },
        ],
      });

      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "60";
      process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS = "12";
      process.env.SESSION_MAX_SESSIONS = "10";

      const policy = await mod.loadSessionPolicy();

      expect(policy).toEqual({
        idleTimeoutMinutes: 60,
        absoluteTimeoutHours: 12,
        maxSessions: 10,
      });
    });

    it("partial env vars only override the specified fields", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          {
            value: {
              idle_timeout_minutes: 15,
              absolute_timeout_hours: 4,
              max_sessions: 3,
            },
          },
        ],
      });

      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "60";

      const policy = await mod.loadSessionPolicy();

      expect(policy).toEqual({
        idleTimeoutMinutes: 60,
        absoluteTimeoutHours: 4,
        maxSessions: 3,
      });
    });

    it("ignores invalid env var values", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "not-a-number";
      process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS = "-5";

      const policy = await mod.loadSessionPolicy();

      expect(policy.idleTimeoutMinutes).toBe(30);
      expect(policy.absoluteTimeoutHours).toBe(8); // default preserved
    });

    it('rejects env var value "0" (must be positive)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      process.env.SESSION_IDLE_TIMEOUT_MINUTES = "0";
      process.env.SESSION_MAX_SESSIONS = "0";

      const policy = await mod.loadSessionPolicy();

      expect(policy.idleTimeoutMinutes).toBe(30); // default
      expect(policy.maxSessions).toBeNull(); // default
    });

    it("accepts fractional env var values", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS = "1.5";

      const policy = await mod.loadSessionPolicy();

      expect(policy.absoluteTimeoutHours).toBe(1.5);
    });

    it("handles DB row with partial fields", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          {
            value: {
              idle_timeout_minutes: 45,
              // absolute_timeout_hours and max_sessions not set
            },
          },
        ],
      });

      const policy = await mod.loadSessionPolicy();

      expect(policy.idleTimeoutMinutes).toBe(45);
      expect(policy.absoluteTimeoutHours).toBe(8); // default
      expect(policy.maxSessions).toBeNull(); // default
    });

    it("handles DB row with max_sessions explicitly null", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          {
            value: {
              idle_timeout_minutes: 20,
              absolute_timeout_hours: 6,
              max_sessions: null,
            },
          },
        ],
      });

      const policy = await mod.loadSessionPolicy();

      expect(policy.maxSessions).toBeNull();
    });
  });

  // ── isIdleTimedOut ─────────────────────────────────────────────

  describe("isIdleTimedOut", () => {
    it("returns false when last_active_at is within timeout", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(mod.isIdleTimedOut(fiveMinutesAgo, 30)).toBe(false);
    });

    it("returns true when last_active_at exceeds timeout", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(mod.isIdleTimedOut(twoHoursAgo, 30)).toBe(true);
    });

    it("returns false at exactly the boundary", () => {
      // Exactly 30 minutes ago should not be timed out (> vs >=)
      const exactlyAtBoundary = new Date(Date.now() - 30 * 60 * 1000);
      expect(mod.isIdleTimedOut(exactlyAtBoundary, 30)).toBe(false);
    });
  });

  // ── isAbsoluteTimedOut ─────────────────────────────────────────

  describe("isAbsoluteTimedOut", () => {
    it("returns false when created_at is within timeout", () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      expect(mod.isAbsoluteTimedOut(oneHourAgo, 8)).toBe(false);
    });

    it("returns true when created_at exceeds timeout", () => {
      const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
      expect(mod.isAbsoluteTimedOut(tenHoursAgo, 8)).toBe(true);
    });

    it("returns false at exactly the boundary", () => {
      const exactlyAtBoundary = new Date(Date.now() - 8 * 60 * 60 * 1000);
      expect(mod.isAbsoluteTimedOut(exactlyAtBoundary, 8)).toBe(false);
    });
  });
});
