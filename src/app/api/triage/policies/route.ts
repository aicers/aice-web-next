import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";
import {
  createPolicy,
  listPolicies,
  TriagePolicyNameConflictError,
} from "@/lib/triage/policy/repository";
import { policyCreateSchema } from "@/lib/triage/policy/types";
import { validatePolicySemantics } from "@/lib/triage/policy/validation";

/**
 * GET /api/triage/policies?customer_id=<id>
 *
 * Lists triage policies in the given customer's tenant DB. The
 * `customer_id` query argument is required and is checked against the
 * caller's effective customer scope.
 *
 * Requires `triage:read` permission. (Listing is read-only — write is
 * gated separately on POST.)
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const rows = await listPolicies(customerId);
      return NextResponse.json({ data: rows });
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
  },
  { requiredPermissions: ["triage:read"] },
);

/**
 * POST /api/triage/policies?customer_id=<id>
 *
 * Creates a new triage policy in the given customer's tenant DB.
 *
 * Requires `triage:policy:write` permission.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = policyCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const semantic = validatePolicySemantics(parsed.data);
    if (!semantic.valid) {
      return NextResponse.json(
        { error: "Validation failed", details: semantic.issues },
        { status: 400 },
      );
    }

    try {
      const row = await createPolicy(customerId, parsed.data);
      await auditLog.record({
        actor: session.accountId,
        action: "triage.policy.create",
        target: "triage_policy",
        targetId: String(row.id),
        ip: extractClientIp(request),
        sid: session.sessionId,
        customerId,
        details: { name: row.name },
      });
      return NextResponse.json({ data: row }, { status: 201 });
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof TriagePolicyNameConflictError) {
        return NextResponse.json(
          { error: err.message, field: "name", code: "name_conflict" },
          { status: 409 },
        );
      }
      throw err;
    }
  },
  { requiredPermissions: ["triage:policy:write"] },
);

// ── Helpers ─────────────────────────────────────────────────────

function parseCustomerId(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get("customer_id");
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function callerCanAccessCustomer(
  accountId: string,
  roles: string[],
  customerId: number,
): Promise<boolean> {
  if (await hasPermission(roles, "customers:access-all")) return true;
  const { rows } = await query<{ customer_id: number }>(
    "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
    [accountId, customerId],
  );
  return rows.length > 0;
}
