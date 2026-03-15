import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

/**
 * Create a fake PoolClient that delegates to the shared mockQuery.
 * This lets us verify that transactional writes use `client.query()`
 * while keeping the mock assertions simple.
 */
function makeFakeClient() {
  return { query: mockQuery };
}

describe("role-management", () => {
  let mod: typeof import("@/lib/auth/role-management");

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("@/lib/auth/role-management");
    mockQuery.mockClear();
    mockWithTransaction.mockClear();
    // Default: withTransaction executes the callback with a fake client
    mockWithTransaction.mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test mock accepts any callback shape
      async (fn: (client: any) => unknown) => fn(makeFakeClient()),
    );
  });

  // ── getRoles ──────────────────────────────────────────────────

  describe("getRoles", () => {
    it("returns minimal role list", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "System Administrator",
            description: "Full access",
            is_builtin: true,
          },
        ],
        rowCount: 1,
      });

      const result = await mod.getRoles();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("System Administrator");
      // Minimal: no permissions or account_count
      expect(result[0]).not.toHaveProperty("permissions");
      expect(result[0]).not.toHaveProperty("account_count");
    });
  });

  // ── getRolesWithDetails ─────────────────────────────────────

  describe("getRolesWithDetails", () => {
    it("returns all roles with details", async () => {
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await mod.getRoleWithPermissions(999);
      expect(result).toBeNull();
    });

    it("returns role with permissions", async () => {
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const result = await mod.createRole("Existing Role", null, []);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/already exists/);
    });

    it("creates role with permissions inside a transaction", async () => {
      // Check duplicate name (outside transaction)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Inside transaction: insert role, then insert permissions
      mockQuery
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await mod.createRole("New Role", "Test", [
        "accounts:read",
      ]);
      expect(result.valid).toBe(true);
      expect(result.data?.name).toBe("New Role");
      expect(result.data?.permissions).toEqual(["accounts:read"]);
      // Verify withTransaction was called
      expect(mockWithTransaction).toHaveBeenCalledOnce();
    });
  });

  // ── updateRole ──────────────────────────────────────────────

  describe("updateRole", () => {
    it("rejects built-in role modification", async () => {
      // getRoleWithPermissions lookup
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await mod.updateRole(999, "Name", null, []);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not found/);
    });

    it("updates role inside a transaction", async () => {
      // getRoleWithPermissions
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            name: "Old Name",
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
      // Duplicate name check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Inside transaction: update role, delete permissions, insert permissions
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 10,
              name: "New Name",
              description: null,
              is_builtin: false,
              created_at: "2025-01-01",
              updated_at: "2025-01-01",
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await mod.updateRole(10, "New Name", null, [
        "accounts:write",
      ]);
      expect(result.valid).toBe(true);
      expect(result.data?.name).toBe("New Name");
      expect(result.data?.permissions).toEqual(["accounts:write"]);
      expect(mockWithTransaction).toHaveBeenCalledOnce();
    });
  });

  // ── deleteRole ──────────────────────────────────────────────

  describe("deleteRole", () => {
    it("rejects built-in role deletion", async () => {
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await mod.deleteRole(10);
      expect(result.valid).toBe(true);
    });
  });
});
