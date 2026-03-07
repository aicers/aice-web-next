import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

describe("permissions", () => {
  let permissions: typeof import("@/lib/auth/permissions");

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    // Dynamic import to get a fresh module with clean cache
    vi.resetModules();
    permissions = await import("@/lib/auth/permissions");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getPermissions", () => {
    it("returns permissions for a single role", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          { permission: "accounts:read" },
          { permission: "accounts:write" },
        ],
      });

      const perms = await permissions.getPermissions(["System Administrator"]);

      expect(perms).toEqual(new Set(["accounts:read", "accounts:write"]));
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("role_permissions"),
        ["System Administrator"],
      );
    });

    it("returns union of permissions for multiple roles", async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [
            { permission: "accounts:read" },
            { permission: "accounts:write" },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { permission: "accounts:read" },
            { permission: "customers:read" },
          ],
        });

      const perms = await permissions.getPermissions([
        "System Administrator",
        "Tenant Administrator",
      ]);

      expect(perms).toEqual(
        new Set(["accounts:read", "accounts:write", "customers:read"]),
      );
    });

    it("returns empty set for unknown role", async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      const perms = await permissions.getPermissions(["NonExistentRole"]);

      expect(perms).toEqual(new Set());
    });

    it("caches results — second call does not query DB", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ permission: "accounts:read" }],
      });

      await permissions.getPermissions(["System Administrator"]);
      await permissions.getPermissions(["System Administrator"]);

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it("fetches only cache-missing roles", async () => {
      // First call: loads System Administrator
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ permission: "accounts:read" }],
      });
      await permissions.getPermissions(["System Administrator"]);

      // Second call: System Administrator cached, Tenant Administrator fetched
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ permission: "customers:read" }],
      });
      const perms = await permissions.getPermissions([
        "System Administrator",
        "Tenant Administrator",
      ]);

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(mockPoolQuery).toHaveBeenLastCalledWith(expect.any(String), [
        "Tenant Administrator",
      ]);
      expect(perms).toEqual(new Set(["accounts:read", "customers:read"]));
    });
  });

  describe("hasPermission", () => {
    it("returns true when role has the permission", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          { permission: "accounts:read" },
          { permission: "accounts:write" },
        ],
      });

      const result = await permissions.hasPermission(
        ["System Administrator"],
        "accounts:write",
      );

      expect(result).toBe(true);
    });

    it("returns false when role lacks the permission", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ permission: "accounts:read" }],
      });

      const result = await permissions.hasPermission(
        ["Security Monitor"],
        "accounts:write",
      );

      expect(result).toBe(false);
    });
  });

  describe("invalidatePermissionCache", () => {
    it("clears a specific role from cache", async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ permission: "accounts:read" }],
      });

      await permissions.getPermissions(["System Administrator"]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);

      permissions.invalidatePermissionCache("System Administrator");

      await permissions.getPermissions(["System Administrator"]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    it("clears entire cache when no role specified", async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ permission: "accounts:read" }],
        })
        .mockResolvedValueOnce({
          rows: [{ permission: "customers:read" }],
        });

      await permissions.getPermissions(["System Administrator"]);
      await permissions.getPermissions(["Tenant Administrator"]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);

      permissions.invalidatePermissionCache();

      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ permission: "accounts:read" }],
        })
        .mockResolvedValueOnce({
          rows: [{ permission: "customers:read" }],
        });

      await permissions.getPermissions([
        "System Administrator",
        "Tenant Administrator",
      ]);
      expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    });
  });
});
