import "server-only";

import { NextResponse } from "next/server";

import { queryAudit } from "@/lib/audit/client";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/lib/audit/schema";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

// ── Types ────────────────────────────────────────────────────────

interface AuditLogRow {
  id: string;
  timestamp: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  sid: string | null;
  customer_id: number | null;
  correlation_id: string | null;
}

interface CountRow {
  count: string;
}

// ── Constants ────────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set(AUDIT_ACTIONS);

const ALLOWED_TARGET_TYPES = new Set(AUDIT_TARGET_TYPES);

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ── Helpers ──────────────────────────────────────────────────────

function isValidISODate(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function isAllowedAction(
  value: string,
): value is (typeof AUDIT_ACTIONS)[number] {
  return ALLOWED_ACTIONS.has(value as (typeof AUDIT_ACTIONS)[number]);
}

function isAllowedTargetType(
  value: string,
): value is (typeof AUDIT_TARGET_TYPES)[number] {
  return ALLOWED_TARGET_TYPES.has(value as (typeof AUDIT_TARGET_TYPES)[number]);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Route Handler ────────────────────────────────────────────────

/**
 * GET /api/audit-logs
 *
 * Search and filter audit log entries. Requires `audit-logs:read`.
 * Results are scoped to the caller's effective customer set unless
 * the caller holds `customers:access-all`.
 *
 * Query parameters:
 *   page, pageSize, from, to, actor, action, targetType, targetId,
 *   correlationId
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const url = request.nextUrl;

    // ── Customer scope (project principle 3) ─────────────────────
    //
    // Branch on two independent signals:
    //   1. `isAdmin` — authoritative admin signal from the
    //      `customers:access-all` permission. Only this branch may
    //      omit the customer_id predicate (so admins see rows with
    //      `customer_id IS NULL`).
    //   2. `allowedCustomerIds` — the predicate values for non-admin
    //      callers, materialized from `account_customer`. A non-admin
    //      who happens to be assigned to every customer must still
    //      receive the explicit `customer_id IN (...)` filter, or
    //      audit-agnostic (`customer_id IS NULL`) rows would leak via
    //      the admin-only "no predicate" path.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    const allowedCustomerIds = isAdmin
      ? []
      : await resolveEffectiveCustomerIds(session.accountId, session.roles);
    if (!isAdmin && allowedCustomerIds.length === 0) {
      const emptyPage = Math.max(
        DEFAULT_PAGE,
        Number.parseInt(url.searchParams.get("page") ?? "", 10) || DEFAULT_PAGE,
      );
      const emptyPageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(
          1,
          Number.parseInt(url.searchParams.get("pageSize") ?? "", 10) ||
            DEFAULT_PAGE_SIZE,
        ),
      );
      return NextResponse.json({
        data: [],
        total: 0,
        page: emptyPage,
        pageSize: emptyPageSize,
      });
    }

    // ── Parse pagination ──────────────────────────────────────────

    const page = Math.max(
      DEFAULT_PAGE,
      Number.parseInt(url.searchParams.get("page") ?? "", 10) || DEFAULT_PAGE,
    );
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("pageSize") ?? "", 10) ||
          DEFAULT_PAGE_SIZE,
      ),
    );

    // ── Build dynamic WHERE clause ────────────────────────────────

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    // Date range
    const from = url.searchParams.get("from");
    if (from) {
      if (!isValidISODate(from)) {
        return NextResponse.json(
          { error: "Invalid 'from' date" },
          { status: 400 },
        );
      }
      conditions.push(`timestamp >= $${idx++}`);
      params.push(from);
    }

    const to = url.searchParams.get("to");
    if (to) {
      if (!isValidISODate(to)) {
        return NextResponse.json(
          { error: "Invalid 'to' date" },
          { status: 400 },
        );
      }
      conditions.push(`timestamp <= $${idx++}`);
      params.push(to);
    }

    // Actor
    const actor = url.searchParams.get("actor");
    if (actor) {
      conditions.push(`actor_id = $${idx++}`);
      params.push(actor);
    }

    // Action (validated)
    const action = url.searchParams.get("action");
    if (action) {
      if (!isAllowedAction(action)) {
        return NextResponse.json(
          { error: "Invalid action type" },
          { status: 400 },
        );
      }
      conditions.push(`action = $${idx++}`);
      params.push(action);
    }

    // Target type (validated)
    const targetType = url.searchParams.get("targetType");
    if (targetType) {
      if (!isAllowedTargetType(targetType)) {
        return NextResponse.json(
          { error: "Invalid target type" },
          { status: 400 },
        );
      }
      conditions.push(`target_type = $${idx++}`);
      params.push(targetType);
    }

    // Target ID
    const targetId = url.searchParams.get("targetId");
    if (targetId) {
      conditions.push(`target_id = $${idx++}`);
      params.push(targetId);
    }

    // Correlation ID (validated as UUID)
    const correlationId = url.searchParams.get("correlationId");
    if (correlationId) {
      if (!UUID_RE.test(correlationId)) {
        return NextResponse.json(
          { error: "Invalid correlation ID format" },
          { status: 400 },
        );
      }
      conditions.push(`correlation_id = $${idx++}`);
      params.push(correlationId);
    }

    // ── Customer scope predicate ──────────────────────────────────
    //
    // Restricted callers (`!isAdmin`) get an explicit
    // `customer_id IN ($N, ...)` predicate. Rows with
    // `customer_id IS NULL` (audit-agnostic events such as
    // `account.login`) are intentionally excluded — surfacing them
    // to a restricted viewer is out of scope for this issue.
    if (!isAdmin) {
      const placeholders = allowedCustomerIds.map(() => `$${idx++}`).join(", ");
      conditions.push(`customer_id IN (${placeholders})`);
      params.push(...allowedCustomerIds);
    }

    // ── Execute queries ───────────────────────────────────────────

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Total count (shares the same WHERE + params)
    const { rows: countRows } = await queryAudit<CountRow>(
      `SELECT COUNT(*) AS count FROM audit_logs ${where}`,
      params,
    );
    const total = Number.parseInt(countRows[0].count, 10);

    // Data page
    const offset = (page - 1) * pageSize;
    const { rows } = await queryAudit<AuditLogRow>(
      `SELECT id, timestamp, actor_id, action, target_type, target_id,
              details, ip_address, sid, customer_id, correlation_id
         FROM audit_logs ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset],
    );

    return NextResponse.json({ data: rows, total, page, pageSize });
  },
  { requiredPermissions: ["audit-logs:read"] },
);
