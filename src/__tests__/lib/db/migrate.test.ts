import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClientQuery,
  mockRelease,
  mockAdminPoolEnd,
  mockAdminPoolQuery,
  mockPoolEnd,
  mockPoolConnect,
  mockPoolQuery,
} = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockAdminPoolEnd = vi.fn();
  const mockAdminPoolQuery = vi.fn();
  const mockPoolEnd = vi.fn();
  const mockPoolConnect = vi.fn();
  const mockPoolQuery = vi.fn();
  return {
    mockClientQuery,
    mockRelease,
    mockAdminPoolEnd,
    mockAdminPoolQuery,
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
  connectTo: vi.fn((connectionString: string) => {
    if (connectionString === process.env.DATABASE_ADMIN_URL) {
      return {
        query: mockAdminPoolQuery,
        connect: mockPoolConnect,
        end: mockAdminPoolEnd,
      };
    }

    return {
      query: mockPoolQuery,
      connect: mockPoolConnect,
      end: mockPoolEnd,
    };
  }),
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
  withTransaction: vi.fn(),
}));

const tmpDir = path.join(__dirname, ".tmp-migrations");

function writeMigration(subdir: string, filename: string, sql: string) {
  const dir = path.join(tmpDir, "migrations", subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), sql);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("migrate", () => {
  let migrate: typeof import("@/lib/db/migrate");

  beforeEach(async () => {
    vi.resetModules();

    mkdirSync(tmpDir, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    process.env.DATABASE_URL =
      "postgres://postgres:postgres@localhost:5432/auth_db";
    process.env.DATABASE_ADMIN_URL =
      "postgres://postgres:postgres@localhost:5432/postgres";

    mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockRelease.mockReset();
    mockAdminPoolEnd.mockReset().mockResolvedValue(undefined);
    mockAdminPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
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
    delete process.env.DATABASE_ADMIN_URL;
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

  // ── computeChecksum ─────────────────────────────────────────────────

  describe("computeChecksum", () => {
    it("returns SHA-256 hex digest of content", () => {
      const content = "CREATE TABLE foo (id INT)";
      const expected = sha256(content);
      expect(migrate._computeChecksum(content)).toBe(expected);
    });

    it("produces different checksums for different content", () => {
      const a = migrate._computeChecksum("SELECT 1");
      const b = migrate._computeChecksum("SELECT 2");
      expect(a).not.toBe(b);
    });
  });

  // ── hasNoTransactionMarker ──────────────────────────────────────────

  describe("hasNoTransactionMarker", () => {
    it("returns true when first line is exactly '-- no-transaction'", () => {
      expect(
        migrate._hasNoTransactionMarker(
          "-- no-transaction\nCREATE INDEX CONCURRENTLY idx ON t (col);",
        ),
      ).toBe(true);
    });

    it("returns false for normal SQL", () => {
      expect(migrate._hasNoTransactionMarker("CREATE TABLE t (id INT);")).toBe(
        false,
      );
    });

    it("returns false when marker is not on the first line", () => {
      expect(
        migrate._hasNoTransactionMarker(
          "-- some comment\n-- no-transaction\nSELECT 1;",
        ),
      ).toBe(false);
    });

    it("returns false for partial match", () => {
      expect(
        migrate._hasNoTransactionMarker("-- no-transaction-please\nSELECT 1;"),
      ).toBe(false);
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

      const sql1 = "CREATE TABLE a (id INT)";
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({
          rows: [{ version: "0001", checksum: sha256(sql1) }],
          rowCount: 1,
        }); // SELECT version, checksum

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
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT version, checksum
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

    it("acquires and releases advisory lock", async () => {
      writeMigration("auth", "0001_init.sql", "SELECT 1");

      await migrate.migrateAuthDb();

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("SELECT pg_advisory_lock($1)");
      expect(queries).toContain("SELECT pg_advisory_unlock($1)");
    });

    it("releases advisory lock even on failure", async () => {
      writeMigration("auth", "0001_bad.sql", "INVALID SQL");

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT version, checksum
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error("syntax error")); // migration SQL

      await expect(migrate.migrateAuthDb()).rejects.toThrow("syntax error");

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("SELECT pg_advisory_unlock($1)");
    });
  });

  // ── checksum validation ─────────────────────────────────────────────

  describe("checksum validation", () => {
    it("stores checksum when applying a migration", async () => {
      const sql = "CREATE TABLE a (id INT)";
      writeMigration("auth", "0001_init.sql", sql);

      await migrate.migrateAuthDb();

      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO _migrations"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.[1]).toEqual(["0001", "init", sha256(sql)]);
    });

    it("aborts when checksum of applied migration does not match", async () => {
      const originalSql = "CREATE TABLE a (id INT)";
      const modifiedSql = "CREATE TABLE a (id BIGINT)";
      writeMigration("auth", "0001_init.sql", modifiedSql);

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({
          rows: [{ version: "0001", checksum: sha256(originalSql) }],
          rowCount: 1,
        }); // SELECT version, checksum

      await expect(migrate.migrateAuthDb()).rejects.toThrow(
        "Checksum mismatch",
      );
    });

    it("backfills NULL checksums from current file on disk", async () => {
      const sql = "CREATE TABLE a (id INT)";
      writeMigration("auth", "0001_init.sql", sql);

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({
          rows: [{ version: "0001", checksum: null }],
          rowCount: 1,
        }) // SELECT version, checksum — NULL checksum
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE checksum

      const count = await migrate.migrateAuthDb();

      expect(count).toBe(0);
      const updateCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("UPDATE _migrations SET checksum"),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall?.[1]).toEqual([sha256(sql), "0001"]);
    });
  });

  // ── no-transaction marker ───────────────────────────────────────────

  describe("no-transaction migrations", () => {
    it("skips BEGIN/COMMIT for migrations with -- no-transaction marker", async () => {
      const sql =
        "-- no-transaction\nCREATE INDEX CONCURRENTLY idx ON t (col);";
      writeMigration("auth", "0001_idx.sql", sql);

      await migrate.migrateAuthDb();

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain(sql);
      // Should NOT have BEGIN/COMMIT around the migration
      const sqlIndex = queries.indexOf(sql);
      // Check that the query before the SQL is not BEGIN
      const queriesBefore = queries.slice(0, sqlIndex);
      expect(queriesBefore[queriesBefore.length - 1]).not.toBe("BEGIN");
    });

    it("uses transaction for normal migrations", async () => {
      writeMigration("auth", "0001_init.sql", "CREATE TABLE a (id INT)");

      await migrate.migrateAuthDb();

      const queries = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain("BEGIN");
      expect(queries).toContain("COMMIT");
    });
  });

  // ── provisionCustomerDb ─────────────────────────────────────────────

  describe("provisionCustomerDb", () => {
    it("drops database on migration failure", async () => {
      writeMigration("customer", "0001_init.sql", "CREATE TABLE t (id INT)");

      // CREATE DATABASE succeeds
      mockAdminPoolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      // Pool connect for customer migrations fails
      mockPoolConnect.mockResolvedValueOnce({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT version, checksum
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
          .mockRejectedValueOnce(new Error("migration failed")),
        release: vi.fn(),
      });

      await expect(migrate.provisionCustomerDb("customer_42")).rejects.toThrow(
        "migration failed",
      );

      // Should attempt DROP DATABASE on failure
      expect(mockAdminPoolQuery).toHaveBeenCalledWith(
        'DROP DATABASE IF EXISTS "customer_42"',
      );
    });
  });

  // ── dropCustomerDb ──────────────────────────────────────────────────

  describe("dropCustomerDb", () => {
    it("executes DROP DATABASE with escaped name", async () => {
      await migrate.dropCustomerDb("customer_42");

      expect(mockAdminPoolQuery).toHaveBeenCalledWith(
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

      const sql = "CREATE TABLE audit_logs (id BIGSERIAL)";
      writeMigration("audit", "0001_init_audit_logs.sql", sql);

      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({
          rows: [{ version: "0001", checksum: sha256(sql) }],
          rowCount: 1,
        }); // SELECT version, checksum — already applied

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
        if (url === process.env.DATABASE_ADMIN_URL) {
          callOrder.push("admin");
          return {
            query: mockAdminPoolQuery,
            connect: mockPoolConnect,
            end: mockAdminPoolEnd,
          } as never;
        }

        if (url.includes("auth_db")) callOrder.push("auth");
        else if (url.includes("audit_db")) callOrder.push("audit");
        else callOrder.push("customer");
        return {
          query: mockPoolQuery,
          connect: mockPoolConnect,
          end: mockPoolEnd,
        } as never;
      });

      // Crash recovery: SELECT provisioning customers → empty
      vi.mocked(clientQuery).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      // Active customers query (called after auth + audit migrations)
      vi.mocked(clientQuery).mockResolvedValueOnce({
        rows: [{ database_name: "customer_1" }],
        rowCount: 1,
      });

      await migrate.runStartupMigrations();

      expect(callOrder).toEqual(["auth", "audit", "customer"]);
    });

    it("uses the admin connection when cleaning stale provisioning databases", async () => {
      process.env.AUDIT_DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/audit_db";

      writeMigration("auth", "0001_init.sql", "SELECT 1");
      writeMigration("audit", "0001_init.sql", "SELECT 1");

      const { connectTo, query: clientQuery } = await import("@/lib/db/client");

      vi.mocked(connectTo).mockImplementation((url: string) => {
        if (url === process.env.DATABASE_ADMIN_URL) {
          return {
            query: mockAdminPoolQuery,
            connect: mockPoolConnect,
            end: mockAdminPoolEnd,
          } as never;
        }

        return {
          query: mockPoolQuery,
          connect: mockPoolConnect,
          end: mockPoolEnd,
        } as never;
      });

      vi.mocked(clientQuery)
        .mockResolvedValueOnce({
          rows: [{ database_name: "customer_stale" }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await migrate.runStartupMigrations();

      expect(mockAdminPoolQuery).toHaveBeenCalledWith(
        'DROP DATABASE IF EXISTS "customer_stale"',
      );
    });
  });
});
