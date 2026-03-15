import "server-only";

import { query } from "@/lib/db/client";

// ── Cache ──────────────────────────────────────────────────────

/**
 * In-memory cache: role name → set of permission strings.
 *
 * Lazy-loaded on first permission check per role.  Next.js may spin up
 * multiple runtime instances, each with its own cache — this is
 * acceptable because the cache is read-only until a role is modified
 * (Phase 3-2), at which point `invalidatePermissionCache()` is called.
 */
const rolePermissionCache = new Map<string, Set<string>>();

// ── Internal ───────────────────────────────────────────────────

async function loadRolePermissions(roleName: string): Promise<Set<string>> {
  const cached = rolePermissionCache.get(roleName);
  if (cached) return cached;

  const { rows } = await query<{ permission: string }>(
    `SELECT rp.permission
     FROM role_permissions rp
     JOIN roles r ON rp.role_id = r.id
     WHERE r.name = $1`,
    [roleName],
  );

  const permissions = new Set(rows.map((r) => r.permission));
  rolePermissionCache.set(roleName, permissions);
  return permissions;
}

// ── Constants ─────────────────────────────────────────────────

/**
 * Single source of truth for all permission strings in the system.
 * Used for the permission checkbox grid in role management UI and
 * for validating permission values on the server side.
 *
 * Grouped by resource for display purposes.
 */
export const ALL_PERMISSIONS = {
  accounts: ["accounts:read", "accounts:write", "accounts:delete"],
  roles: ["roles:read", "roles:write", "roles:delete"],
  customers: ["customers:read", "customers:write", "customers:access-all"],
  "audit-logs": ["audit-logs:read"],
  "system-settings": ["system-settings:read", "system-settings:write"],
} as const;

/** Flat set of all valid permission strings. */
export const VALID_PERMISSIONS: Set<string> = new Set(
  Object.values(ALL_PERMISSIONS).flat(),
);

// ── Public API ─────────────────────────────────────────────────

/**
 * Return the union of all permissions for the given role names.
 *
 * Results are cached per role name; only cache-missing roles trigger a
 * database query.
 */
export async function getPermissions(
  roleNames: string[],
): Promise<Set<string>> {
  const union = new Set<string>();

  for (const roleName of roleNames) {
    const perms = await loadRolePermissions(roleName);
    for (const p of perms) {
      union.add(p);
    }
  }

  return union;
}

/**
 * Check whether the given roles collectively grant the specified
 * permission.
 */
export async function hasPermission(
  roleNames: string[],
  permission: string,
): Promise<boolean> {
  const perms = await getPermissions(roleNames);
  return perms.has(permission);
}

/**
 * Clear cached permissions for a specific role, or the entire cache if
 * no role name is provided.
 *
 * Call this when roles or role_permissions are modified (Phase 3-2).
 */
export function invalidatePermissionCache(roleName?: string): void {
  if (roleName) {
    rolePermissionCache.delete(roleName);
  } else {
    rolePermissionCache.clear();
  }
}
