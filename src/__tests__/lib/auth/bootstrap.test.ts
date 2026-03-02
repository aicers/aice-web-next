import type { PathLike } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPoolQuery, mockAuditPoolQuery, mockAuditPoolEnd } = vi.hoisted(
  () => {
    const mockPoolQuery = vi.fn();
    const mockAuditPoolQuery = vi.fn();
    const mockAuditPoolEnd = vi.fn();
    return { mockPoolQuery, mockAuditPoolQuery, mockAuditPoolEnd };
  },
);

vi.mock("@/lib/db/client", () => ({
  connectTo: vi.fn(() => ({
    query: mockAuditPoolQuery,
    end: mockAuditPoolEnd,
  })),
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$argon2id$v=19$mocked-hash"),
    verify: vi.fn().mockResolvedValue(true),
    argon2id: 2,
  },
}));

const tmpDir = path.join(__dirname, ".tmp-bootstrap");
const dataDir = path.join(tmpDir, "data");
const secretsDir = path.join(tmpDir, "secrets");

function writeSecret(filename: string, content: string) {
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(path.join(secretsDir, filename), content);
}

describe("bootstrap", () => {
  let bootstrap: typeof import("@/lib/auth/bootstrap");

  beforeEach(async () => {
    vi.resetModules();

    mkdirSync(tmpDir, { recursive: true });

    process.env.DATABASE_URL =
      "postgres://postgres:postgres@localhost:5432/auth_db";
    process.env.AUDIT_DATABASE_URL =
      "postgres://audit_writer:changeme@localhost:5432/audit_db";
    process.env.DATA_DIR = dataDir;

    delete process.env.INIT_ADMIN_USERNAME;
    delete process.env.INIT_ADMIN_PASSWORD;

    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditPoolEnd.mockReset().mockResolvedValue(undefined);

    // Patch secret file paths for testing
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();

      const originalReadFileSync = actual.readFileSync;
      const originalUnlinkSync = actual.unlinkSync;
      const originalAccessSync = actual.accessSync;

      return {
        ...actual,
        readFileSync: vi.fn(
          (filePath: PathLike | number, encoding?: BufferEncoding) => {
            // Redirect secret file reads to tmp directory
            if (filePath === "/run/secrets/init_admin_username") {
              return originalReadFileSync(
                path.join(secretsDir, "init_admin_username"),
                encoding as BufferEncoding,
              );
            }
            if (filePath === "/run/secrets/init_admin_password") {
              return originalReadFileSync(
                path.join(secretsDir, "init_admin_password"),
                encoding as BufferEncoding,
              );
            }
            return originalReadFileSync(filePath, encoding as BufferEncoding);
          },
        ),
        unlinkSync: vi.fn((filePath: PathLike) => {
          const fp = String(filePath);
          if (
            fp === "/run/secrets/init_admin_username" ||
            fp === "/run/secrets/init_admin_password"
          ) {
            return originalUnlinkSync(path.join(secretsDir, path.basename(fp)));
          }
          return originalUnlinkSync(filePath);
        }),
        accessSync: vi.fn((filePath: string, mode?: number) => {
          // DATA_DIR marker check uses actual path, no redirect needed
          return originalAccessSync(filePath, mode);
        }),
      };
    });

    bootstrap = await import("@/lib/auth/bootstrap");
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AUDIT_DATABASE_URL;
    delete process.env.DATA_DIR;
    delete process.env.INIT_ADMIN_USERNAME;
    delete process.env.INIT_ADMIN_PASSWORD;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── credential resolution ───────────────────────────────────────

  describe("credential resolution", () => {
    it("reads from secret files when they exist", async () => {
      writeSecret("init_admin_username", "file-admin\n");
      writeSecret("init_admin_password", "file-pass123\n");

      // COUNT(*) returns 0
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      // Role lookup
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      // INSERT RETURNING
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-123" }],
        rowCount: 1,
      });
      // password_history INSERT
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      // Verify INSERT was called with trimmed username from file
      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO accounts"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.[1]).toEqual([
        "file-admin",
        "file-admin",
        "$argon2id$v=19$mocked-hash",
        1,
      ]);
    });

    it("falls back to env vars when secret files don't exist", async () => {
      process.env.INIT_ADMIN_USERNAME = "env-admin";
      process.env.INIT_ADMIN_PASSWORD = "env-pass123";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-456" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO accounts"),
      );
      expect(insertCall?.[1]).toEqual([
        "env-admin",
        "env-admin",
        "$argon2id$v=19$mocked-hash",
        1,
      ]);
    });

    it("prefers secret files over env vars when both exist", async () => {
      writeSecret("init_admin_username", "file-admin");
      writeSecret("init_admin_password", "file-pass123");
      process.env.INIT_ADMIN_USERNAME = "env-admin";
      process.env.INIT_ADMIN_PASSWORD = "env-pass123";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-789" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO accounts"),
      );
      expect(insertCall?.[1]?.[0]).toBe("file-admin");
    });

    it("skips when consumed marker exists", async () => {
      writeSecret("init_admin_username", "file-admin");
      writeSecret("init_admin_password", "file-pass123");

      // Write consumed marker
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, ".init_admin_consumed"), "consumed");

      // No env vars set → no credentials available
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });

      await bootstrap.bootstrapAdminAccount();

      // No INSERT should have been attempted
      const insertCalls = mockPoolQuery.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO accounts"),
      );
      expect(insertCalls).toHaveLength(0);
    });

    it("returns early when no credentials are available", async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });

      await bootstrap.bootstrapAdminAccount();

      // Only the COUNT query should have been made
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ── account creation ────────────────────────────────────────────

  describe("account creation", () => {
    it("creates admin when accounts table is empty", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "new-uuid" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO accounts"),
      );
      expect(insertCall).toBeDefined();
      // must_change_password=true is in the SQL literal
      expect(insertCall?.[0]).toContain("true");
    });

    it("skips when accounts already exist", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "3" }],
        rowCount: 1,
      });

      await bootstrap.bootstrapAdminAccount();

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it("inserts password_history entry", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "new-uuid" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      const historyCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("INSERT INTO password_history"),
      );
      expect(historyCall).toBeDefined();
      expect(historyCall?.[1]).toEqual([
        "new-uuid",
        "$argon2id$v=19$mocked-hash",
      ]);
    });

    it("throws when System Administrator role is missing", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      // Role lookup returns empty
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(bootstrap.bootstrapAdminAccount()).rejects.toThrow(
        'Role "System Administrator" not found',
      );
    });
  });

  // ── race condition handling ─────────────────────────────────────

  describe("race condition handling", () => {
    it("handles concurrent insert gracefully (INSERT returns 0 rows)", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      // COUNT returns 0 (stale read)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      // INSERT returns 0 rows (another instance won)
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Should not throw
      await bootstrap.bootstrapAdminAccount();

      // No audit log should be written
      expect(mockAuditPoolQuery).not.toHaveBeenCalled();
    });
  });

  // ── secret file consumption ─────────────────────────────────────

  describe("secret file consumption", () => {
    it("deletes secret files after successful bootstrap", async () => {
      writeSecret("init_admin_username", "file-admin");
      writeSecret("init_admin_password", "file-pass123");

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-del" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      // Verify unlinkSync was called for both secret paths
      const fs = await import("node:fs");
      const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map((c) => c[0]);
      expect(unlinkCalls).toContain("/run/secrets/init_admin_username");
      expect(unlinkCalls).toContain("/run/secrets/init_admin_password");
    });

    it("writes consumed marker when deletion fails", async () => {
      writeSecret("init_admin_username", "file-admin");
      writeSecret("init_admin_password", "file-pass123");

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-marker" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      // Make unlinkSync throw for secret paths
      const fs = await import("node:fs");
      vi.mocked(fs.unlinkSync).mockImplementation((filePath: PathLike) => {
        const fp = String(filePath);
        if (
          fp === "/run/secrets/init_admin_username" ||
          fp === "/run/secrets/init_admin_password"
        ) {
          throw new Error("EROFS: read-only file system");
        }
      });

      await bootstrap.bootstrapAdminAccount();

      // Verify marker was written to disk (writeFileSync uses real impl via ...actual)
      const markerPath = path.join(dataDir, ".init_admin_consumed");
      const { existsSync, readFileSync } = await import("node:fs");
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf8");
      // Marker contains an ISO timestamp
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does not consume files when source is env_var", async () => {
      process.env.INIT_ADMIN_USERNAME = "env-admin";
      process.env.INIT_ADMIN_PASSWORD = "env-pass123";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "uuid-env" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      const fs = await import("node:fs");
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
    });
  });

  // ── audit logging ───────────────────────────────────────────────

  describe("audit logging", () => {
    it("writes audit log entry on successful creation", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "audit-uuid" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await bootstrap.bootstrapAdminAccount();

      expect(mockAuditPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_logs"),
        [
          "system",
          "account.create",
          "account",
          "audit-uuid",
          JSON.stringify({
            username: "admin",
            role: "System Administrator",
            source: "bootstrap",
          }),
        ],
      );
      expect(mockAuditPoolEnd).toHaveBeenCalled();
    });

    it("warns but does not fail when AUDIT_DATABASE_URL is missing", async () => {
      delete process.env.AUDIT_DATABASE_URL;

      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "no-audit-uuid" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await bootstrap.bootstrapAdminAccount();

      expect(warnSpy).toHaveBeenCalledWith(
        "AUDIT_DATABASE_URL not set; skipping bootstrap audit log entry",
      );
      expect(mockAuditPoolQuery).not.toHaveBeenCalled();
    });

    it("warns but does not fail when audit DB query throws", async () => {
      process.env.INIT_ADMIN_USERNAME = "admin";
      process.env.INIT_ADMIN_PASSWORD = "secure-password";

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ count: "0" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: "audit-fail-uuid" }],
        rowCount: 1,
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      // Simulate audit DB connection/query failure
      mockAuditPoolQuery.mockRejectedValueOnce(
        new Error("ECONNREFUSED: audit_db unreachable"),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw — admin account is already created
      await bootstrap.bootstrapAdminAccount();

      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to write bootstrap audit log; admin account was created successfully",
        expect.any(Error),
      );
      // Audit pool should still be cleaned up
      expect(mockAuditPoolEnd).toHaveBeenCalled();
    });
  });

  // ── constants ───────────────────────────────────────────────────

  describe("constants", () => {
    it("exports MAX_SYSTEM_ADMINISTRATORS as 5", () => {
      expect(bootstrap.MAX_SYSTEM_ADMINISTRATORS).toBe(5);
    });
  });
});
