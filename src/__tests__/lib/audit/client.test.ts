import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock setup ────────────────────────────────────────────────────

const { mockPoolQuery, mockPoolEnd, connectTo } = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockPoolEnd = vi.fn();
  const connectTo = vi.fn(() => ({
    query: mockPoolQuery,
    end: mockPoolEnd,
  }));
  return { mockPoolQuery, mockPoolEnd, connectTo };
});

vi.mock("@/lib/db/client", () => ({
  connectTo,
}));

describe("audit client", () => {
  let client: typeof import("@/lib/audit/client");

  beforeEach(async () => {
    vi.resetModules();
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset();
    connectTo.mockClear();

    process.env.AUDIT_DATABASE_URL =
      "postgres://audit_reader:pass@localhost:5432/audit_db";

    client = await import("@/lib/audit/client");
  });

  afterEach(() => {
    client.resetAuditReadPool();
    delete process.env.AUDIT_DATABASE_URL;
  });

  // ── queryAudit ──────────────────────────────────────────────────

  describe("queryAudit()", () => {
    it("returns rows and rowCount from audit_db", async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1, action: "auth.sign_in.success" }],
        rowCount: 1,
      });

      const result = await client.queryAudit("SELECT * FROM audit_logs");

      expect(result.rows).toEqual([{ id: 1, action: "auth.sign_in.success" }]);
      expect(result.rowCount).toBe(1);
    });

    it("creates pool lazily on first call", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await client.queryAudit("SELECT 1");

      expect(connectTo).toHaveBeenCalledWith(
        "postgres://audit_reader:pass@localhost:5432/audit_db",
      );
    });

    it("reuses pool across multiple calls", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await client.queryAudit("SELECT 1");
      await client.queryAudit("SELECT 2");

      expect(connectTo).toHaveBeenCalledTimes(1);
    });

    it("throws when AUDIT_DATABASE_URL is missing", async () => {
      delete process.env.AUDIT_DATABASE_URL;
      client.resetAuditReadPool();

      await expect(client.queryAudit("SELECT 1")).rejects.toThrow(
        "Missing environment variable: AUDIT_DATABASE_URL",
      );
    });

    it("propagates database errors", async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error("connection refused"));

      await expect(client.queryAudit("SELECT 1")).rejects.toThrow(
        "connection refused",
      );
    });

    it("passes params to the pool query", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await client.queryAudit("SELECT * FROM audit_logs WHERE id = $1", [42]);

      expect(mockPoolQuery).toHaveBeenCalledWith(
        "SELECT * FROM audit_logs WHERE id = $1",
        [42],
      );
    });
  });

  // ── endAuditReadPool ────────────────────────────────────────────

  describe("endAuditReadPool()", () => {
    it("ends the pool and resets reference", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await client.queryAudit("SELECT 1"); // initialize pool
      mockPoolEnd.mockResolvedValueOnce(undefined);

      await client.endAuditReadPool();

      expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    });

    it("is safe when no pool exists", async () => {
      client.resetAuditReadPool();
      await client.endAuditReadPool();

      expect(mockPoolEnd).not.toHaveBeenCalled();
    });
  });

  // ── resetAuditReadPool ──────────────────────────────────────────

  describe("resetAuditReadPool()", () => {
    it("clears reference so next call creates new pool", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await client.queryAudit("SELECT 1");
      expect(connectTo).toHaveBeenCalledTimes(1);

      client.resetAuditReadPool();
      await client.queryAudit("SELECT 2");
      expect(connectTo).toHaveBeenCalledTimes(2);
    });
  });
});
