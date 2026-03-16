import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { validateManagedAccountTarget } from "@/lib/auth/account-management";
import {
  loadAccountRolePolicy,
  rolePermissionsSelectSql,
  SYSTEM_ADMIN_ROLE_NAME,
} from "@/lib/auth/account-role-policy";
import { MAX_SYSTEM_ADMINISTRATORS } from "@/lib/auth/bootstrap";
import { getAccountCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";

// ── Types ───────────────────────────────────────────────────────

interface AccountDetailRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_id: number;
  role_name: string;
  role_permissions?: string[];
  status: string;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Constants ───────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = new Set(["active", "locked", "suspended", "disabled"]);

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/accounts/[id]
 *
 * Fetch a single account. Tenant-scoped unless the caller holds
 * `customers:access-all`.
 *
 * Requires `accounts:read` permission.
 */
export const GET = withAuth(
  async (_request, context, session) => {
    const { id: accountId } = await context.params;
    if (!UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID" },
        { status: 400 },
      );
    }

    const { rows } = await query<AccountDetailRow>(
      `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              a.role_id, r.name AS role_name, a.status,
              a.last_sign_in_at, a.created_at, a.updated_at
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Tenant scope check
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      const targetCustomerIds = await getAccountCustomerIds(accountId);
      const overlap = targetCustomerIds.some((id) =>
        callerCustomerIds.includes(id),
      );
      if (!overlap && accountId !== session.accountId) {
        return NextResponse.json(
          { error: "Account not found" },
          { status: 404 },
        );
      }
    }

    return NextResponse.json({ data: rows[0] });
  },
  { requiredPermissions: ["accounts:read"] },
);

/**
 * PATCH /api/accounts/[id]
 *
 * Update an account's profile fields, role, or status.
 *
 * - Self-update of basic fields (display_name, email, phone) is always
 *   allowed without `accounts:write`.
 * - Updating other accounts or changing role/status requires
 *   `accounts:write`.
 * - Cannot change own role or status.
 * - Tenant-scoped operators can only manage Security Monitor accounts.
 */
export const PATCH = withAuth(async (request, context, session) => {
  const { id: accountId } = await context.params;
  if (!UUID_RE.test(accountId)) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 400 });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const isSelf = accountId === session.accountId;
  const hasWritePerm = await hasPermission(session.roles, "accounts:write");

  // Fetch target account
  const { rows: existing } = await query<AccountDetailRow>(
    `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              a.role_id, r.name AS role_name,
              ${rolePermissionsSelectSql("r", "role_permissions")},
              a.status,
              a.last_sign_in_at, a.created_at, a.updated_at
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
    [accountId],
  );
  if (existing.length === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  // Tenant scope check (for other accounts)
  if (!isSelf) {
    if (!hasWritePerm) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const accessError = await validateManagedAccountTarget(
      session,
      existing[0],
    );
    if (accessError) {
      return NextResponse.json(
        { error: accessError.error },
        { status: accessError.status },
      );
    }
  }

  // Build updates
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  const changes: Record<string, unknown> = {};

  // Basic fields (always allowed for self)
  if (typeof body.displayName === "string") {
    const val = body.displayName.trim();
    if (val) {
      updates.push(`display_name = $${idx++}`);
      params.push(val);
      changes.displayName = val;
    }
  }
  if (body.email !== undefined) {
    const val =
      typeof body.email === "string" ? body.email.trim() || null : null;
    updates.push(`email = $${idx++}`);
    params.push(val);
    changes.email = val;
  }
  if (body.phone !== undefined) {
    const val =
      typeof body.phone === "string" ? body.phone.trim() || null : null;
    updates.push(`phone = $${idx++}`);
    params.push(val);
    changes.phone = val;
  }

  // Privileged fields (require accounts:write, cannot change own)
  if (body.roleId !== undefined) {
    if (!hasWritePerm) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isSelf) {
      return NextResponse.json(
        { error: "Cannot change own role" },
        { status: 400 },
      );
    }
    const newRoleId = Number(body.roleId);
    if (!Number.isFinite(newRoleId)) {
      return NextResponse.json({ error: "Invalid roleId" }, { status: 400 });
    }
    // Verify role exists
    const nextRole = await loadAccountRolePolicy(newRoleId);
    if (!nextRole) {
      return NextResponse.json({ error: "Role not found" }, { status: 400 });
    }
    const callerAccessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!callerAccessAll && !nextRole.tenantManageable) {
      return NextResponse.json(
        {
          error:
            "Tenant Administrator can only assign Security Monitor-equivalent roles",
        },
        { status: 403 },
      );
    }
    // System Admin count check if changing away from SysAdmin
    if (
      existing[0].role_name === SYSTEM_ADMIN_ROLE_NAME &&
      !nextRole.isNamedSystemAdministrator
    ) {
      const { rows: countRows } = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM accounts a
           JOIN roles r ON a.role_id = r.id
           WHERE r.name = $1 AND a.status != 'disabled'`,
        [SYSTEM_ADMIN_ROLE_NAME],
      );
      if (Number.parseInt(countRows[0].count, 10) <= 1) {
        return NextResponse.json(
          { error: "Cannot remove the last System Administrator" },
          { status: 400 },
        );
      }
    }
    // System Admin count check if changing to SysAdmin
    if (
      nextRole.isNamedSystemAdministrator &&
      existing[0].role_name !== SYSTEM_ADMIN_ROLE_NAME
    ) {
      const { rows: countRows } = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM accounts a
           JOIN roles r ON a.role_id = r.id
           WHERE r.name = $1 AND a.status != 'disabled'`,
        [SYSTEM_ADMIN_ROLE_NAME],
      );
      if (
        Number.parseInt(countRows[0].count, 10) >= MAX_SYSTEM_ADMINISTRATORS
      ) {
        return NextResponse.json(
          {
            error: `Maximum number of System Administrators (${MAX_SYSTEM_ADMINISTRATORS}) reached`,
          },
          { status: 400 },
        );
      }
    }
    updates.push(`role_id = $${idx++}`);
    params.push(newRoleId);
    changes.roleId = newRoleId;
    changes.roleName = nextRole.roleName;
  }

  if (body.status !== undefined) {
    if (!hasWritePerm) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isSelf) {
      return NextResponse.json(
        { error: "Cannot change own status" },
        { status: 400 },
      );
    }
    const newStatus = String(body.status);
    if (!VALID_STATUSES.has(newStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.push(`status = $${idx++}`);
    params.push(newStatus);
    changes.status = newStatus;

    // If disabling, bump token_version to invalidate JWTs
    if (newStatus === "disabled") {
      updates.push("token_version = token_version + 1");
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ data: existing[0] });
  }

  updates.push("updated_at = NOW()");
  params.push(accountId);

  const { rows: updated } = await query<AccountDetailRow>(
    `UPDATE accounts SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING id`,
    params,
  );

  if (updated.length === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  // Refetch with role name
  const { rows: result } = await query<AccountDetailRow>(
    `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              a.role_id, r.name AS role_name,
              ${rolePermissionsSelectSql("r", "role_permissions")},
              a.status,
              a.last_sign_in_at, a.created_at, a.updated_at
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
    [accountId],
  );

  // Audit
  await auditLog.record({
    actor: session.accountId,
    action: "account.update",
    target: "account",
    targetId: accountId,
    ip: extractClientIp(request),
    sid: session.sessionId,
    details: changes,
  });

  return NextResponse.json({ data: result[0] });
});

/**
 * DELETE /api/accounts/[id]
 *
 * Disable an account (soft-delete). Bumps `token_version` to
 * invalidate all active JWTs.
 *
 * Requires `accounts:delete` permission.
 *
 * Constraints:
 * - Cannot delete own account
 * - Last System Administrator cannot be deleted
 * - Tenant-scoped operators can only delete Security Monitor accounts
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id: accountId } = await context.params;
    if (!UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID" },
        { status: 400 },
      );
    }

    // Cannot delete self
    if (accountId === session.accountId) {
      return NextResponse.json(
        { error: "Cannot delete own account" },
        { status: 400 },
      );
    }

    // Fetch target account
    const { rows } = await query<AccountDetailRow>(
      `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              a.role_id, r.name AS role_name,
              ${rolePermissionsSelectSql("r", "role_permissions")},
              a.status,
              a.last_sign_in_at, a.created_at, a.updated_at
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const target = rows[0];

    // Already disabled
    if (target.status === "disabled") {
      return NextResponse.json(
        { error: "Account is already disabled" },
        { status: 400 },
      );
    }

    // Scope + role boundary check
    const accessError = await validateManagedAccountTarget(session, target);
    if (accessError) {
      return NextResponse.json(
        { error: accessError.error },
        { status: accessError.status },
      );
    }

    // Last System Administrator check
    if (target.role_name === SYSTEM_ADMIN_ROLE_NAME) {
      const { rows: countRows } = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM accounts a
         JOIN roles r ON a.role_id = r.id
         WHERE r.name = $1 AND a.status != 'disabled'`,
        [SYSTEM_ADMIN_ROLE_NAME],
      );
      if (Number.parseInt(countRows[0].count, 10) <= 1) {
        return NextResponse.json(
          { error: "Cannot delete the last System Administrator" },
          { status: 400 },
        );
      }
    }

    // Soft-delete: disable + bump token_version
    await query(
      `UPDATE accounts
       SET status = 'disabled', token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [accountId],
    );

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "account.delete",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: {
        username: target.username,
        role: target.role_name,
      },
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["accounts:delete"] },
);
