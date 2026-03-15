import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db/client";

const queryMock = vi.mocked(query);

describe("role-management", () => {
  let mod: typeof import("@/lib/auth/role-management");

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("@/lib/auth/role-management");
    queryMock.mockClear();
  });

  // ── getRolesWithDetails ─────────────────────────────────────

  describe("getRolesWithDetails", () => {
    it("returns all roles with details", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "System Administrator",
            description: "Full access",
            is_builtin: true,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: ["accounts:read", "accounts:write"],
            account_count: "3",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.getRolesWithDetails();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("System Administrator");
      expect(result[0].account_count).toBe(3);
      expect(result[0].permissions).toEqual([
        "accounts:read",
        "accounts:write",
      ]);
    });
  });

  // ── getRoleWithPermissions ──────────────────────────────────

  describe("getRoleWithPermissions", () => {
    it("returns null for non-existent role", async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await mod.getRoleWithPermissions(999);
      expect(result).toBeNull();
    });

    it("returns role with permissions", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Test Role",
            description: null,
            is_builtin: false,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: ["accounts:read"],
            account_count: "0",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.getRoleWithPermissions(1);
      expect(result?.name).toBe("Test Role");
      expect(result?.account_count).toBe(0);
    });
  });

  // ── createRole ──────────────────────────────────────────────

  describe("createRole", () => {
    it("rejects empty name", async () => {
      const result = await mod.createRole("", null, ["accounts:read"]);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/Name/);
    });

    it("rejects unknown permissions", async () => {
      const result = await mod.createRole("Test", null, ["unknown:perm"]);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/Unknown permission/);
    });

    it("rejects duplicate name", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const result = await mod.createRole("Existing Role", null, []);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/already exists/);
    });

    it("creates role with permissions", async () => {
      // Check duplicate name
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Insert role
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            name: "New Role",
            description: "Test",
            is_builtin: false,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
          },
        ],
        rowCount: 1,
      });
      // Insert permissions
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await mod.createRole("New Role", "Test", [
        "accounts:read",
      ]);
      expect(result.valid).toBe(true);
      expect(result.data?.name).toBe("New Role");
      expect(result.data?.permissions).toEqual(["accounts:read"]);
    });
  });

  // ── updateRole ──────────────────────────────────────────────

  describe("updateRole", () => {
    it("rejects built-in role modification", async () => {
      // getRoleWithPermissions lookup
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "System Administrator",
            description: null,
            is_builtin: true,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: [],
            account_count: "0",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.updateRole(1, "Renamed", null, []);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/Built-in/);
    });

    it("rejects non-existent role", async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await mod.updateRole(999, "Name", null, []);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not found/);
    });
  });

  // ── deleteRole ──────────────────────────────────────────────

  describe("deleteRole", () => {
    it("rejects built-in role deletion", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "System Administrator",
            description: null,
            is_builtin: true,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: [],
            account_count: "0",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.deleteRole(1);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/Built-in/);
    });

    it("rejects deletion of role in use", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            name: "Custom Role",
            description: null,
            is_builtin: false,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: [],
            account_count: "2",
          },
        ],
        rowCount: 1,
      });

      const result = await mod.deleteRole(10);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/assigned to accounts/);
    });

    it("deletes role successfully", async () => {
      // getRoleWithPermissions
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            name: "Custom Role",
            description: null,
            is_builtin: false,
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
            permissions: [],
            account_count: "0",
          },
        ],
        rowCount: 1,
      });
      // DELETE
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await mod.deleteRole(10);
      expect(result.valid).toBe(true);
    });
  });
});
