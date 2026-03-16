import "server-only";

import { query, withTransaction } from "@/lib/db/client";

import {
  deriveAccountRolePolicy,
  rolePermissionsSelectSql,
  summarizeAccountRolePolicy,
} from "./account-role-policy";
import { invalidatePermissionCache, VALID_PERMISSIONS } from "./permissions";

// ── Types ──────────────────────────────────────────────────────

export interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleWithPermissions extends RoleRow {
  permissions: string[];
  account_count: number;
  requires_customer_assignment: boolean;
  max_customer_assignments: number | null;
  tenant_manageable: boolean;
}

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

// ── Helpers ────────────────────────────────────────────────────

function validateRoleInput(
  name: string,
  permissions: string[],
): ValidationResult {
  const errors: string[] = [];

  if (!name || name.trim().length === 0) {
    errors.push("Name is required");
  } else if (name.trim().length > 100) {
    errors.push("Name must be 100 characters or fewer");
  }

  if (!Array.isArray(permissions)) {
    errors.push("Permissions must be an array");
  } else {
    for (const p of permissions) {
      if (!VALID_PERMISSIONS.has(p)) {
        errors.push(`Unknown permission: ${p}`);
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ── Public API ─────────────────────────────────────────────────

export interface RoleSummary {
  id: number;
  name: string;
  description: string | null;
  is_builtin: boolean;
  requires_customer_assignment: boolean;
  max_customer_assignments: number | null;
  tenant_manageable: boolean;
}

/**
 * List all roles with minimal fields (id, name, description, is_builtin).
 * Safe for any authenticated user — used by account creation forms.
 */
export async function getRoles(): Promise<RoleSummary[]> {
  const { rows } = await query<RoleSummary & { permissions: string[] }>(
    `SELECT r.id, r.name, r.description, r.is_builtin,
            ${rolePermissionsSelectSql("r")}
     FROM roles r
     ORDER BY r.is_builtin DESC, r.name`,
  );
  return rows.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    is_builtin: role.is_builtin,
    ...summarizeAccountRolePolicy(
      deriveAccountRolePolicy({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
      }),
    ),
  }));
}

/**
 * List all roles with their full permissions and account counts.
 * Should only be exposed to users with `roles:read`.
 */
export async function getRolesWithDetails(): Promise<RoleWithPermissions[]> {
  const { rows } = await query<
    RoleRow & { permissions: string[]; account_count: string }
  >(
    `SELECT r.id, r.name, r.description, r.is_builtin,
            r.created_at, r.updated_at,
            ${rolePermissionsSelectSql("r")},
            (SELECT COUNT(*)::TEXT FROM accounts a WHERE a.role_id = r.id) AS account_count
     FROM roles r
     ORDER BY r.is_builtin DESC, r.name`,
  );

  return rows.map((r) => ({
    ...r,
    account_count: Number(r.account_count),
    ...summarizeAccountRolePolicy(
      deriveAccountRolePolicy({
        id: r.id,
        name: r.name,
        permissions: r.permissions,
      }),
    ),
  }));
}

/**
 * Get a single role with its permissions.
 */
export async function getRoleWithPermissions(
  id: number,
): Promise<RoleWithPermissions | null> {
  const { rows } = await query<
    RoleRow & { permissions: string[]; account_count: string }
  >(
    `SELECT r.id, r.name, r.description, r.is_builtin,
            r.created_at, r.updated_at,
            ${rolePermissionsSelectSql("r")},
            (SELECT COUNT(*)::TEXT FROM accounts a WHERE a.role_id = r.id) AS account_count
     FROM roles r
     WHERE r.id = $1`,
    [id],
  );

  if (rows.length === 0) return null;

  const role = rows[0];
  return {
    ...role,
    account_count: Number(role.account_count),
    ...summarizeAccountRolePolicy(
      deriveAccountRolePolicy({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
      }),
    ),
  };
}

/**
 * Create a new custom role with the given permissions.
 */
export async function createRole(
  name: string,
  description: string | null,
  permissions: string[],
): Promise<{ valid: boolean; data?: RoleWithPermissions; errors?: string[] }> {
  const validation = validateRoleInput(name, permissions);
  if (!validation.valid) return validation;

  // Check for duplicate name
  const { rowCount: existing } = await query(
    "SELECT 1 FROM roles WHERE name = $1",
    [name.trim()],
  );
  if (existing && existing > 0) {
    return { valid: false, errors: ["A role with this name already exists"] };
  }

  const role = await withTransaction(async (client) => {
    // Insert role
    const { rows } = await client.query<RoleRow>(
      `INSERT INTO roles (name, description)
       VALUES ($1, $2)
       RETURNING id, name, description, is_builtin, created_at, updated_at`,
      [name.trim(), description?.trim() || null],
    );

    const created = rows[0];

    // Insert permissions
    if (permissions.length > 0) {
      const values = permissions.map((_, i) => `($1, $${i + 2})`).join(", ");
      await client.query(
        `INSERT INTO role_permissions (role_id, permission) VALUES ${values}`,
        [created.id, ...permissions],
      );
    }

    return created;
  });

  invalidatePermissionCache();

  return {
    valid: true,
    data: {
      ...role,
      permissions,
      account_count: 0,
      ...summarizeAccountRolePolicy(
        deriveAccountRolePolicy({
          id: role.id,
          name: role.name,
          permissions,
        }),
      ),
    },
  };
}

/**
 * Update an existing custom role.
 */
export async function updateRole(
  id: number,
  name: string,
  description: string | null,
  permissions: string[],
): Promise<{ valid: boolean; data?: RoleWithPermissions; errors?: string[] }> {
  const validation = validateRoleInput(name, permissions);
  if (!validation.valid) return validation;

  // Check role exists and is not built-in
  const existing = await getRoleWithPermissions(id);
  if (!existing) {
    return { valid: false, errors: ["Role not found"] };
  }
  if (existing.is_builtin) {
    return { valid: false, errors: ["Built-in roles cannot be modified"] };
  }

  // Check for duplicate name (excluding current role)
  const { rowCount: nameConflict } = await query(
    "SELECT 1 FROM roles WHERE name = $1 AND id != $2",
    [name.trim(), id],
  );
  if (nameConflict && nameConflict > 0) {
    return { valid: false, errors: ["A role with this name already exists"] };
  }

  const updated = await withTransaction(async (client) => {
    // Update role
    const { rows } = await client.query<RoleRow>(
      `UPDATE roles SET name = $1, description = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, description, is_builtin, created_at, updated_at`,
      [name.trim(), description?.trim() || null, id],
    );

    // Replace permissions: delete all, then insert new
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [id]);

    if (permissions.length > 0) {
      const values = permissions.map((_, i) => `($1, $${i + 2})`).join(", ");
      await client.query(
        `INSERT INTO role_permissions (role_id, permission) VALUES ${values}`,
        [id, ...permissions],
      );
    }

    return rows[0];
  });

  invalidatePermissionCache(existing.name);
  // Also invalidate new name in case it changed
  if (existing.name !== name.trim()) {
    invalidatePermissionCache(name.trim());
  }

  return {
    valid: true,
    data: {
      ...updated,
      permissions,
      account_count: existing.account_count,
      ...summarizeAccountRolePolicy(
        deriveAccountRolePolicy({
          id: updated.id,
          name: updated.name,
          permissions,
        }),
      ),
    },
  };
}

/**
 * Delete a custom role. Fails if the role is built-in or in use.
 */
export async function deleteRole(
  id: number,
): Promise<{ valid: boolean; errors?: string[] }> {
  const existing = await getRoleWithPermissions(id);
  if (!existing) {
    return { valid: false, errors: ["Role not found"] };
  }
  if (existing.is_builtin) {
    return { valid: false, errors: ["Built-in roles cannot be deleted"] };
  }
  if (existing.account_count > 0) {
    return {
      valid: false,
      errors: [
        "Cannot delete a role that is assigned to accounts. Reassign accounts first.",
      ],
    };
  }

  // role_permissions cascade-deleted via FK
  await query("DELETE FROM roles WHERE id = $1", [id]);

  invalidatePermissionCache(existing.name);

  return { valid: true };
}
