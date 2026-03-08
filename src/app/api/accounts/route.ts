import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { MAX_SYSTEM_ADMINISTRATORS } from "@/lib/auth/bootstrap";
import { getAccountCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-validator";
import { hasPermission } from "@/lib/auth/permissions";
import { query, withTransaction } from "@/lib/db/client";

// ── Types ───────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_name: string;
  status: string;
  last_sign_in_at: string | null;
  created_at: string;
}

// ── Constants ───────────────────────────────────────────────────

const SYSTEM_ADMIN_ROLE = "System Administrator";
const SECURITY_MONITOR_ROLE = "Security Monitor";

const VALID_STATUSES = new Set(["active", "locked", "suspended", "disabled"]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/accounts
 *
 * List accounts with pagination, search, and filtering.
 * Results are scoped by role:
 * - System Administrator: sees all accounts
 * - Tenant Administrator: sees accounts sharing at least one customer
 *
 * Requires `accounts:read` permission.
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const url = request.nextUrl;
    const search = url.searchParams.get("search")?.trim() || "";
    const roleFilter = url.searchParams.get("role") || "";
    const statusFilter = url.searchParams.get("status") || "";
    const customerIdFilter = url.searchParams.get("customerId") || "";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number(url.searchParams.get("pageSize")) || DEFAULT_PAGE_SIZE,
      ),
    );

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Tenant Admin scoping
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      if (callerCustomerIds.length === 0) {
        return NextResponse.json({
          data: [],
          total: 0,
          page,
          pageSize,
        });
      }
      conditions.push(
        `a.id IN (SELECT ac.account_id FROM account_customer ac WHERE ac.customer_id = ANY($${paramIdx}))`,
      );
      params.push(callerCustomerIds);
      paramIdx++;
    }

    // Search filter (username or display_name)
    if (search) {
      conditions.push(
        `(a.username ILIKE $${paramIdx} OR a.display_name ILIKE $${paramIdx})`,
      );
      params.push(`%${search}%`);
      paramIdx++;
    }

    // Role filter
    if (roleFilter) {
      conditions.push(`r.name = $${paramIdx}`);
      params.push(roleFilter);
      paramIdx++;
    }

    // Status filter
    if (statusFilter && VALID_STATUSES.has(statusFilter)) {
      conditions.push(`a.status = $${paramIdx}`);
      params.push(statusFilter);
      paramIdx++;
    }

    // Customer filter
    if (customerIdFilter) {
      const custId = Number(customerIdFilter);
      if (Number.isFinite(custId) && custId > 0) {
        conditions.push(
          `a.id IN (SELECT ac.account_id FROM account_customer ac WHERE ac.customer_id = $${paramIdx})`,
        );
        params.push(custId);
        paramIdx++;
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count
    const { rows: countRows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM accounts a
       JOIN roles r ON a.role_id = r.id
       ${whereClause}`,
      params,
    );
    const total = Number.parseInt(countRows[0].count, 10);

    // Fetch page
    const offset = (page - 1) * pageSize;
    const { rows } = await query<AccountRow>(
      `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              r.name AS role_name, a.status, a.last_sign_in_at, a.created_at
       FROM accounts a
       JOIN roles r ON a.role_id = r.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, pageSize, offset],
    );

    return NextResponse.json({ data: rows, total, page, pageSize });
  },
  { requiredPermissions: ["accounts:read"] },
);

/**
 * POST /api/accounts
 *
 * Create a new account with customer assignment.
 *
 * Body: `{ username, displayName, password, roleId, email?, phone?,
 *          customerIds?: number[] }`
 *
 * Role-based creation rules:
 * - System Administrator: can create any role type
 * - Tenant Administrator: can create Security Monitor only, within scope
 *
 * Requires `accounts:write` permission.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Parse body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const roleId = typeof body.roleId === "number" ? body.roleId : null;
    const email =
      typeof body.email === "string" ? body.email.trim() || null : null;
    const phone =
      typeof body.phone === "string" ? body.phone.trim() || null : null;
    const customerIds = Array.isArray(body.customerIds)
      ? body.customerIds
      : undefined;

    if (!username) {
      return NextResponse.json(
        { error: "Missing required field: username" },
        { status: 400 },
      );
    }
    if (!displayName) {
      return NextResponse.json(
        { error: "Missing required field: displayName" },
        { status: 400 },
      );
    }
    if (!password) {
      return NextResponse.json(
        { error: "Missing required field: password" },
        { status: 400 },
      );
    }
    if (roleId === null) {
      return NextResponse.json(
        { error: "Missing required field: roleId" },
        { status: 400 },
      );
    }

    // Step 2: Look up target role
    const { rows: roleRows } = await query<{ id: number; name: string }>(
      "SELECT id, name FROM roles WHERE id = $1",
      [roleId],
    );
    if (roleRows.length === 0) {
      return NextResponse.json({ error: "Role not found" }, { status: 400 });
    }
    const targetRoleName = roleRows[0].name;

    // Step 3: Tenant Admin can only create Security Monitor
    const callerIsSysAdmin = session.roles.includes(SYSTEM_ADMIN_ROLE);
    if (!callerIsSysAdmin && targetRoleName !== SECURITY_MONITOR_ROLE) {
      return NextResponse.json(
        {
          error:
            "Tenant Administrator can only create Security Monitor accounts",
        },
        { status: 403 },
      );
    }

    // Step 4: System Admin count limit
    if (targetRoleName === SYSTEM_ADMIN_ROLE) {
      const { rows: countRows } = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM accounts a
         JOIN roles r ON a.role_id = r.id
         WHERE r.name = $1 AND a.status != 'disabled'`,
        [SYSTEM_ADMIN_ROLE],
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

    // Step 5: Customer assignment validation
    const requiresCustomerAssignment = targetRoleName !== SYSTEM_ADMIN_ROLE;

    if (requiresCustomerAssignment) {
      if (
        !customerIds ||
        !Array.isArray(customerIds) ||
        customerIds.length === 0
      ) {
        return NextResponse.json(
          {
            error:
              "Customer assignment is required for non-System Administrator accounts",
          },
          { status: 400 },
        );
      }
      if (
        !customerIds.every(
          (id) => typeof id === "number" && Number.isInteger(id) && id > 0,
        )
      ) {
        return NextResponse.json(
          { error: "customerIds must be positive integers" },
          { status: 400 },
        );
      }
    }

    // Security Monitor: max 1 customer
    if (
      targetRoleName === SECURITY_MONITOR_ROLE &&
      customerIds &&
      customerIds.length > 1
    ) {
      return NextResponse.json(
        {
          error:
            "Security Monitor accounts can only be assigned to a single customer",
        },
        { status: 400 },
      );
    }

    // Deduplicate
    const uniqueCustomerIds = customerIds ? [...new Set(customerIds)] : [];

    // Verify customers exist
    if (uniqueCustomerIds.length > 0) {
      const { rows: existingCustomers } = await query<{ id: number }>(
        "SELECT id FROM customers WHERE id = ANY($1)",
        [uniqueCustomerIds],
      );
      if (existingCustomers.length !== uniqueCustomerIds.length) {
        const found = new Set(existingCustomers.map((r) => r.id));
        const missing = uniqueCustomerIds.filter((id) => !found.has(id));
        return NextResponse.json(
          { error: `Customers not found: ${missing.join(", ")}` },
          { status: 400 },
        );
      }
    }

    // Tenant Admin scope: can only assign their own customers
    if (!callerIsSysAdmin && uniqueCustomerIds.length > 0) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      const callerSet = new Set(callerCustomerIds);
      const outOfScope = uniqueCustomerIds.filter((id) => !callerSet.has(id));
      if (outOfScope.length > 0) {
        return NextResponse.json(
          { error: "Cannot assign customers outside your scope" },
          { status: 403 },
        );
      }
    }

    // Step 6: Password validation (skip reuse check for new accounts)
    const pwResult = await validatePassword(
      password,
      "00000000-0000-0000-0000-000000000000",
      true,
    );
    if (!pwResult.valid) {
      return NextResponse.json(
        {
          error: "Password does not meet policy requirements",
          details: pwResult.errors,
        },
        { status: 400 },
      );
    }

    // Step 7: Hash password
    const passwordHash = await hashPassword(password);

    // Step 8: Insert account + customer assignments + password history
    let accountId: string;
    try {
      accountId = await withTransaction(async (client) => {
        // Check username uniqueness
        const { rows: existingRows } = await client.query<{ id: string }>(
          "SELECT id FROM accounts WHERE username = $1",
          [username],
        );
        if (existingRows.length > 0) {
          throw new UsernameConflictError();
        }

        // Insert account
        const { rows: insertedRows } = await client.query<{ id: string }>(
          `INSERT INTO accounts (username, display_name, password_hash, role_id, email, phone, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id`,
          [username, displayName, passwordHash, roleId, email, phone],
        );
        const newId = insertedRows[0].id;

        // Insert customer assignments
        if (uniqueCustomerIds.length > 0) {
          const insertValues = uniqueCustomerIds
            .map((_, i) => `($1, $${i + 2})`)
            .join(", ");
          const insertParams: (string | number)[] = [
            newId,
            ...uniqueCustomerIds,
          ];
          await client.query(
            `INSERT INTO account_customer (account_id, customer_id) VALUES ${insertValues}`,
            insertParams,
          );
        }

        // Insert password history
        await client.query(
          "INSERT INTO password_history (account_id, password_hash) VALUES ($1, $2)",
          [newId, passwordHash],
        );

        return newId;
      });
    } catch (err) {
      if (err instanceof UsernameConflictError) {
        return NextResponse.json(
          { error: "Username already exists" },
          { status: 409 },
        );
      }
      throw err;
    }

    // Step 9: Audit
    await auditLog.record({
      actor: session.accountId,
      action: "account.create",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: {
        username,
        displayName,
        role: targetRoleName,
        customerIds: uniqueCustomerIds,
      },
    });

    // Step 10: Fetch and return the created account
    const { rows: created } = await query<AccountRow>(
      `SELECT a.id, a.username, a.display_name, a.email, a.phone,
              r.name AS role_name, a.status, a.last_sign_in_at, a.created_at
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );

    return NextResponse.json({ data: created[0] }, { status: 201 });
  },
  { requiredPermissions: ["accounts:write"] },
);

// ── Internal ────────────────────────────────────────────────────

class UsernameConflictError extends Error {
  constructor() {
    super("Username already exists");
  }
}
