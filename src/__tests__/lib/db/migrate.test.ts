import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClientQuery,
  mockRelease,
  mockPoolEnd,
  mockPoolConnect,
  mockPoolQuery,
} = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockPoolEnd = vi.fn();
  const mockPoolConnect = vi.fn();
  const mockPoolQuery = vi.fn();
  return {
    mockClientQuery,
    mockRelease,
    mockPoolEnd,
    mockPoolConnect,
    mockPoolQuery,
  };
});

vi.mock("pg", () => {
  const Pool = vi.fn(() => ({
    query: mockPoolQuery,
    connect: mockPoolConnect,
    end: mockPoolEnd,
  }));
  return { default: { Pool } };
});

vi.mock("@/lib/db/client", () => ({
  connectTo: vi.fn(() => ({
    query: mockPoolQuery,
    connect: mockPoolConnect,
    end: mockPoolEnd,
  })),
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
  withTransaction: vi.fn(),
}));

const tmpDir = path.join(__dirname, ".tmp-migrations");

function writeMigration(subdir: string, filename: string, sql: string) {
  const dir = path.join(tmpDir, "migrations", subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), sql);
}

describe("migrate", () => {
  let migrate: typeof import("@/lib/db/migrate");

  beforeEach(async () => {
    vi.resetModules();

    mkdirSync(tmpDir, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    process.env.DATABASE_URL =
      "postgres://postgres:postgres@localhost:5432/auth_db";

    mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockRelease.mockReset();
    mockPoolEnd.mockReset().mockResolvedValue(undefined);
    mockPoolConnect.mockReset().mockResolvedValue({
      query: mockClientQuery,
      release: mockRelease,
    });
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });

    migrate = await import("@/lib/db/migrate");
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AUDIT_DATABASE_URL;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── scanMigrations ──────────────────────────────────────────────────

  describe("scanMigrations", () => {
    it("returns sorted migration files", () => {
      writeMigration("auth", "0002_add_sessions.sql", "SELECT 1");
      writeMigration("auth", "0001_init_schema.sql", "SELECT 1");

      const migrations = migrate._scanMigrations(
        path.join(tmpDir, "migrations", "auth"),
      );

      expect(migrations).toHaveLength(2);
      expect(migrations[0].version).toBe("0001");
      expect(migrations[1].version).toBe("0002");
    });

    it("ignores non-sql files", () => {
      writeMigration("auth", "0001_init_schema.sql", "SELECT 1");
      writeMigration("auth", "README.md", "not a migration");

      const migrations = migrate._scanMigrations(
        path.join(tmpDir, "migrations", "auth"),
      );

      expect(migrations).toHaveLength(1);
    });

    it("ignores files with invalid naming", () => {
      writeMigration("auth", "0001_init_schema.sql", "SELECT 1");
      writeMigration("auth", "bad_name.sql", "SELECT 1");

      const migrations = migrate._scanMigrations(
        path.join(tmpDir, "migrations", "auth"),
      );

      expect(migrations).toHaveLength(1);
      expect(migrations[0].version).toBe("0001");
    });

    it("returns empty array for missing directory", () => {
      const migrations = migrate._scanMigrations("/nonexistent");

      expect(migrations).toEqual([]);
    });
  });

  // ── migrateAuthDb ───────────────────────────────────────────────────

  describe("migrateAuthDb", () => {
    it("applies pending migrations sequentially", async () => {
      writeMigration("auth", "0001_init_schema.sql", "CREATE TABLE a (id INT)");
      writeMigration("auth", "0002_add_col.sql", "ALTER TABLE a ADD name TEXT");

      const count = await migrate.migrateAuthDb();

      expect(count).toBe(2);

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("CREATE TABLE a (id INT)");
      expect(queries).toContain("ALTER TABLE a ADD name TEXT");
    });

    it("skips already-applied migrations", async () => {
      writeMigration("auth", "0001_init_schema.sql", "CREATE TABLE a (id INT)");
      writeMigration("auth", "0002_add_col.sql", "ALTER TABLE a ADD name TEXT");

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({
          rows: [{ version: "0001" }],
          rowCount: 1,
        }); // SELECT versions

      const count = await migrate.migrateAuthDb();

      expect(count).toBe(1);
      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).not.toContain("CREATE TABLE a (id INT)");
      expect(queries).toContain("ALTER TABLE a ADD name TEXT");
    });

    it("returns 0 when no migration files exist", async () => {
      const count = await migrate.migrateAuthDb();

      expect(count).toBe(0);
    });

    it("rolls back on migration failure", async () => {
      writeMigration("auth", "0001_bad.sql", "INVALID SQL");

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT versions
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error("syntax error")); // migration SQL

      await expect(migrate.migrateAuthDb()).rejects.toThrow("syntax error");

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("BEGIN");
      expect(queries).toContain("ROLLBACK");
      expect(queries).not.toContain("COMMIT");
    });

    it("ends the pool after migration", async () => {
      writeMigration("auth", "0001_init_schema.sql", "SELECT 1");

      await migrate.migrateAuthDb();

      expect(mockPoolEnd).toHaveBeenCalled();
    });
  });

  // ── provisionCustomerDb ─────────────────────────────────────────────

  describe("provisionCustomerDb", () => {
    it("drops database on migration failure", async () => {
      writeMigration("customer", "0001_init.sql", "CREATE TABLE t (id INT)");

      const { query: clientQuery } = await import("@/lib/db/client");

      // CREATE DATABASE succeeds
      vi.mocked(clientQuery).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      // Pool connect for customer migrations fails
      mockPoolConnect.mockResolvedValueOnce({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT versions
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
          .mockRejectedValueOnce(new Error("migration failed")),
        release: vi.fn(),
      });

      await expect(migrate.provisionCustomerDb("customer_42")).rejects.toThrow(
        "migration failed",
      );

      // Should attempt DROP DATABASE on failure
      expect(vi.mocked(clientQuery)).toHaveBeenCalledWith(
        'DROP DATABASE IF EXISTS "customer_42"',
      );
    });
  });

  // ── dropCustomerDb ──────────────────────────────────────────────────

  describe("dropCustomerDb", () => {
    it("executes DROP DATABASE with escaped name", async () => {
      const { query: clientQuery } = await import("@/lib/db/client");

      await migrate.dropCustomerDb("customer_42");

      expect(vi.mocked(clientQuery)).toHaveBeenCalledWith(
        'DROP DATABASE IF EXISTS "customer_42"',
      );
    });
  });

  // ── migrateAuditDb ────────────────────────────────────────────────

  describe("migrateAuditDb", () => {
    it("applies pending audit migrations using AUDIT_DATABASE_URL", async () => {
      process.env.AUDIT_DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/audit_db";

      writeMigration(
        "audit",
        "0001_init_audit_logs.sql",
        "CREATE TABLE audit_logs (id BIGSERIAL)",
      );

      const count = await migrate.migrateAuditDb();

      expect(count).toBe(1);

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("CREATE TABLE audit_logs (id BIGSERIAL)");
    });

    it("throws when AUDIT_DATABASE_URL is missing", async () => {
      delete process.env.AUDIT_DATABASE_URL;

      writeMigration(
        "audit",
        "0001_init_audit_logs.sql",
        "CREATE TABLE audit_logs (id BIGSERIAL)",
      );

      await expect(migrate.migrateAuditDb()).rejects.toThrow(
        "Missing environment variable: AUDIT_DATABASE_URL",
      );
    });

    it("returns 0 when no audit migration files exist", async () => {
      process.env.AUDIT_DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/audit_db";

      const count = await migrate.migrateAuditDb();

      expect(count).toBe(0);
    });

    it("skips already-applied audit migrations (idempotency)", async () => {
      process.env.AUDIT_DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/audit_db";

      writeMigration(
        "audit",
        "0001_init_audit_logs.sql",
        "CREATE TABLE audit_logs (id BIGSERIAL)",
      );

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({
          rows: [{ version: "0001" }],
          rowCount: 1,
        }); // SELECT versions — already applied

      const count = await migrate.migrateAuditDb();

      expect(count).toBe(0);
      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).not.toContain("CREATE TABLE audit_logs (id BIGSERIAL)");
    });
  });

  // ── runStartupMigrations ──────────────────────────────────────────

  describe("runStartupMigrations", () => {
    it("runs auth → audit → customer migrations in order", async () => {
      process.env.AUDIT_DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/audit_db";

      writeMigration("auth", "0001_init.sql", "SELECT 1");
      writeMigration("audit", "0001_init.sql", "SELECT 1");
      writeMigration("customer", "0001_init.sql", "SELECT 1");

      const { connectTo, query: clientQuery } = await import("@/lib/db/client");
      const callOrder: string[] = [];

      vi.mocked(connectTo).mockImplementation((url: string) => {
        if (url.includes("auth_db")) callOrder.push("auth");
        else if (url.includes("audit_db")) callOrder.push("audit");
        else callOrder.push("customer");
        return {
          query: mockPoolQuery,
          connect: mockPoolConnect,
          end: mockPoolEnd,
        } as never;
      });

      // customers query (called after auth + audit migrations)
      vi.mocked(clientQuery).mockResolvedValueOnce({
        rows: [{ database_name: "customer_1" }],
        rowCount: 1,
      });

      await migrate.runStartupMigrations();

      expect(callOrder).toEqual(["auth", "audit", "customer"]);
    });
  });
});
