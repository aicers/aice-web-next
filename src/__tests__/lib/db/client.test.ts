import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockConnect, mockEnd, mockRelease, mockPoolClient } =
  vi.hoisted(() => ({
    mockQuery: vi.fn(),
    mockConnect: vi.fn(),
    mockEnd: vi.fn(),
    mockRelease: vi.fn(),
    mockPoolClient: { query: vi.fn(), release: vi.fn() },
  }));

vi.mock("pg", () => ({
  default: {
    Pool: class MockPool {
      query = mockQuery;
      connect = mockConnect;
      end = mockEnd;
    },
  },
}));

describe("db client", () => {
  let client: typeof import("@/lib/db/client");

  beforeEach(async () => {
    vi.resetModules();
    process.env.DATABASE_URL =
      "postgres://postgres:postgres@localhost:5432/auth_db";

    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockConnect.mockReset().mockResolvedValue(mockPoolClient);
    mockEnd.mockReset().mockResolvedValue(undefined);
    mockRelease.mockReset();
    mockPoolClient.query
      .mockReset()
      .mockResolvedValue({ rows: [], rowCount: 0 });
    mockPoolClient.release = mockRelease;

    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // ── query ───────────────────────────────────────────────────────────

  describe("query", () => {
    it("executes SQL with parameters", async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

      const result = await client.query(
        "SELECT * FROM users WHERE id = $1",
        [1],
      );

      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE id = $1",
        [1],
      );
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(result.rowCount).toBe(1);
    });

    it("executes SQL without parameters", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await client.query("SELECT 1");

      expect(mockQuery).toHaveBeenCalledWith("SELECT 1", undefined);
    });

    it("throws when DATABASE_URL is missing", async () => {
      delete process.env.DATABASE_URL;
      client.resetPool();

      await expect(client.query("SELECT 1")).rejects.toThrow(
        "Missing environment variable: DATABASE_URL",
      );
    });
  });

  // ── withTransaction ─────────────────────────────────────────────────

  describe("withTransaction", () => {
    it("wraps function in BEGIN/COMMIT", async () => {
      await client.withTransaction(async (txClient) => {
        await txClient.query("INSERT INTO users (name) VALUES ($1)", ["alice"]);
      });

      const calls = mockPoolClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls[0]).toBe("BEGIN");
      expect(calls[1]).toBe("INSERT INTO users (name) VALUES ($1)");
      expect(calls[2]).toBe("COMMIT");
    });

    it("rolls back on error", async () => {
      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql === "INSERT INTO users (name) VALUES ($1)") {
          return Promise.reject(new Error("constraint violation"));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(
        client.withTransaction(async (txClient) => {
          await txClient.query("INSERT INTO users (name) VALUES ($1)", [
            "alice",
          ]);
        }),
      ).rejects.toThrow("constraint violation");

      const calls = mockPoolClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls[0]).toBe("BEGIN");
      expect(calls[1]).toBe("INSERT INTO users (name) VALUES ($1)");
      expect(calls[2]).toBe("ROLLBACK");
    });

    it("releases client after commit", async () => {
      await client.withTransaction(async () => {});

      expect(mockRelease).toHaveBeenCalledOnce();
    });

    it("releases client after rollback", async () => {
      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql !== "BEGIN" && sql !== "ROLLBACK") {
          return Promise.reject(new Error("fail"));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(
        client.withTransaction(async (txClient) => {
          await txClient.query("BAD SQL");
        }),
      ).rejects.toThrow("fail");

      expect(mockRelease).toHaveBeenCalledOnce();
    });

    it("returns the value from the callback", async () => {
      const result = await client.withTransaction(async () => 42);

      expect(result).toBe(42);
    });
  });

  // ── connectTo ───────────────────────────────────────────────────────

  describe("connectTo", () => {
    it("creates a pool for the given connection string", () => {
      const pool = client.connectTo("postgres://localhost/test_db");

      expect(pool).toBeDefined();
      expect(pool.query).toBeDefined();
    });
  });

  // ── end ─────────────────────────────────────────────────────────────

  describe("end", () => {
    it("ends the pool", async () => {
      // Trigger pool creation
      await client.query("SELECT 1");

      await client.end();

      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it("is safe to call when no pool exists", async () => {
      client.resetPool();
      await client.end();
      // No error thrown
    });
  });
});
