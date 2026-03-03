import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock setup ────────────────────────────────────────────────────

const { mockPoolQuery, mockPoolEnd } = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockPoolEnd = vi.fn();
  return { mockPoolQuery, mockPoolEnd };
});

vi.mock("@/lib/db/client", () => ({
  connectTo: vi.fn(() => ({
    query: mockPoolQuery,
    end: mockPoolEnd,
  })),
}));

const { mockGetCorrelationId } = vi.hoisted(() => {
  const mockGetCorrelationId = vi.fn();
  return { mockGetCorrelationId };
});

vi.mock("@/lib/audit/correlation", () => ({
  getCorrelationId: mockGetCorrelationId,
}));

// ── Import after mocks ───────────────────────────────────────────

import type { AuditAction } from "@/lib/audit/logger";

describe("auditLog", () => {
  let auditLog: typeof import("@/lib/audit/logger")["auditLog"];

  beforeEach(async () => {
    vi.resetModules();
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset();
    mockGetCorrelationId.mockReset();

    process.env.AUDIT_DATABASE_URL =
      "postgres://audit_writer:pass@localhost:5432/audit_db";

    const mod = await import("@/lib/audit/logger");
    auditLog = mod.auditLog;
  });

  afterEach(async () => {
    auditLog.resetPool();
    delete process.env.AUDIT_DATABASE_URL;
  });

  // ── record() — basic insertion ────────────────────────────────

  describe("record() — basic insertion", () => {
    it("inserts event with all fields populated", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "user-123",
        action: "auth.sign_in.success",
        target: "session",
        targetId: "session-456",
        details: { username: "admin", ip: "10.0.0.1" },
        ip: "10.0.0.1",
        sid: "sid-789",
        customerId: 42,
        correlationId: "corr-abc",
      });

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_logs"),
        [
          "user-123",
          "auth.sign_in.success",
          "session",
          "session-456",
          JSON.stringify({ username: "admin", ip: "10.0.0.1" }),
          "10.0.0.1",
          "sid-789",
          42,
          "corr-abc",
        ],
      );
    });

    it("inserts event with minimal fields", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_logs"),
        [
          "system",
          "account.create",
          "account",
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      );
    });

    it("serializes details as JSON string", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "user-1",
        action: "account.lock",
        target: "account",
        targetId: "user-2",
        details: { reason: "too many failures", count: 5 },
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBe(
        JSON.stringify({ reason: "too many failures", count: 5 }),
      );
    });

    it("passes null when details is undefined", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.unlock",
        target: "account",
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBeNull();
    });
  });

  // ── record() — correlation ID ─────────────────────────────────

  describe("record() — correlation ID", () => {
    it("uses explicitly provided correlationId", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockGetCorrelationId.mockReturnValue("als-id");

      await auditLog.record({
        actor: "user-1",
        action: "auth.sign_out",
        target: "session",
        correlationId: "explicit-id",
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[8]).toBe("explicit-id");
    });

    it("auto-reads from AsyncLocalStorage when correlationId is omitted", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockGetCorrelationId.mockReturnValue("als-correlation-id");

      await auditLog.record({
        actor: "user-1",
        action: "auth.sign_in.success",
        target: "session",
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[8]).toBe("als-correlation-id");
    });

    it("passes null when neither explicit nor ALS correlation ID is available", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockGetCorrelationId.mockReturnValue(undefined);

      await auditLog.record({
        actor: "user-1",
        action: "auth.sign_in.failure",
        target: "account",
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[8]).toBeNull();
    });

    it("prefers explicit correlationId over ALS value", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockGetCorrelationId.mockReturnValue("als-value");

      await auditLog.record({
        actor: "user-1",
        action: "auth.session_extend",
        target: "session",
        correlationId: "explicit-value",
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[8]).toBe("explicit-value");
    });
  });

  // ── record() — sensitive field redaction ───────────────────────

  describe("record() — sensitive field redaction", () => {
    it("redacts top-level password field", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
        details: { username: "admin", password: "secret123" },
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      const details = JSON.parse(params[4] as string);
      expect(details.password).toBe("[REDACTED]");
      expect(details.username).toBe("admin");
    });

    it("redacts password_hash in nested before/after objects", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "user-1",
        action: "account.create",
        target: "account",
        details: {
          before: { password_hash: "old-hash", status: "active" },
          after: { password_hash: "new-hash", status: "locked" },
        },
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      const details = JSON.parse(params[4] as string);
      expect(details.before.password_hash).toBe("[REDACTED]");
      expect(details.before.status).toBe("active");
      expect(details.after.password_hash).toBe("[REDACTED]");
      expect(details.after.status).toBe("locked");
    });

    it("preserves non-sensitive fields intact", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "user-1",
        action: "account.lock",
        target: "account",
        details: { reason: "brute force", count: 5, ip: "10.0.0.1" },
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      const details = JSON.parse(params[4] as string);
      expect(details).toEqual({
        reason: "brute force",
        count: 5,
        ip: "10.0.0.1",
      });
    });

    it("redacts all known sensitive keys", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
        details: {
          password: "p",
          passwordHash: "ph",
          secret: "s",
          token: "t",
          accessToken: "at",
          refreshToken: "rt",
          apiKey: "ak",
          privateKey: "pk",
          credential: "c",
          username: "admin",
        },
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      const details = JSON.parse(params[4] as string);
      expect(details.password).toBe("[REDACTED]");
      expect(details.passwordHash).toBe("[REDACTED]");
      expect(details.secret).toBe("[REDACTED]");
      expect(details.token).toBe("[REDACTED]");
      expect(details.accessToken).toBe("[REDACTED]");
      expect(details.refreshToken).toBe("[REDACTED]");
      expect(details.apiKey).toBe("[REDACTED]");
      expect(details.privateKey).toBe("[REDACTED]");
      expect(details.credential).toBe("[REDACTED]");
      expect(details.username).toBe("admin");
    });

    it("handles details with no sensitive fields unchanged", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const originalDetails = { action: "login", user: "alice" };

      await auditLog.record({
        actor: "user-1",
        action: "auth.sign_in.success",
        target: "session",
        details: originalDetails,
      });

      const params = mockPoolQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBe(JSON.stringify(originalDetails));
    });
  });

  // ── record() — error handling ─────────────────────────────────

  describe("record() — error handling", () => {
    it("propagates database errors", async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error("connection refused"));

      await expect(
        auditLog.record({
          actor: "user-1",
          action: "auth.sign_in.success",
          target: "session",
        }),
      ).rejects.toThrow("connection refused");
    });

    it("throws when AUDIT_DATABASE_URL is missing", async () => {
      delete process.env.AUDIT_DATABASE_URL;
      auditLog.resetPool();

      // Re-import to get a fresh module without the cached pool
      vi.resetModules();
      const mod = await import("@/lib/audit/logger");

      await expect(
        mod.auditLog.record({
          actor: "user-1",
          action: "auth.sign_in.success",
          target: "session",
        }),
      ).rejects.toThrow("AUDIT_DATABASE_URL");
    });
  });

  // ── Pool management ───────────────────────────────────────────

  describe("pool management", () => {
    it("creates pool lazily on first record() call", async () => {
      const { connectTo } = await import("@/lib/db/client");
      (connectTo as ReturnType<typeof vi.fn>).mockClear();
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      // Pool should not exist before first call
      auditLog.resetPool();
      expect(connectTo).not.toHaveBeenCalled();

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });

      expect(connectTo).toHaveBeenCalledWith(
        "postgres://audit_writer:pass@localhost:5432/audit_db",
      );
    });

    it("reuses pool across multiple record() calls", async () => {
      const { connectTo } = await import("@/lib/db/client");
      (connectTo as ReturnType<typeof vi.fn>).mockClear();
      auditLog.resetPool();
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });
      await auditLog.record({
        actor: "system",
        action: "account.lock",
        target: "account",
      });
      await auditLog.record({
        actor: "system",
        action: "account.unlock",
        target: "account",
      });

      // connectTo called only once despite 3 record() calls
      expect(connectTo).toHaveBeenCalledTimes(1);
    });

    it("endPool() ends the pool and resets reference", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPoolEnd.mockResolvedValueOnce(undefined);

      // Trigger pool creation
      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });

      await auditLog.endPool();

      expect(mockPoolEnd).toHaveBeenCalledOnce();
    });

    it("endPool() is safe when no pool exists", async () => {
      // Should not throw
      await auditLog.endPool();
      expect(mockPoolEnd).not.toHaveBeenCalled();
    });

    it("resetPool() clears reference without ending", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      // Trigger pool creation
      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });

      auditLog.resetPool();
      expect(mockPoolEnd).not.toHaveBeenCalled();
    });
  });

  // ── SQL safety ────────────────────────────────────────────────

  describe("SQL safety", () => {
    it("only uses INSERT SQL (never UPDATE or DELETE)", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await auditLog.record({
        actor: "system",
        action: "account.create",
        target: "account",
      });

      const sql = mockPoolQuery.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO audit_logs");
      expect(sql.toUpperCase()).not.toContain("UPDATE");
      expect(sql.toUpperCase()).not.toContain("DELETE");
    });
  });

  // ── Event type coverage ───────────────────────────────────────

  describe("event type coverage", () => {
    const PHASE_1_ACTIONS: AuditAction[] = [
      "auth.sign_in.success",
      "auth.sign_in.failure",
      "auth.sign_out",
      "auth.session_extend",
      "session.ip_mismatch",
      "session.ua_mismatch",
      "session.revoke",
      "account.create",
      "account.lock",
      "account.unlock",
    ];

    for (const action of PHASE_1_ACTIONS) {
      it(`accepts action: ${action}`, async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await auditLog.record({
          actor: "system",
          action,
          target: "account",
        });

        const params = mockPoolQuery.mock.calls.at(-1)?.[1] as unknown[];
        expect(params[1]).toBe(action);
      });
    }
  });
});
