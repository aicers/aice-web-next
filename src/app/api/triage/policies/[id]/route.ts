import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";
import {
  deletePolicy,
  getPolicy,
  TriagePolicyNameConflictError,
  updatePolicy,
} from "@/lib/triage/policy/repository";
import { policyUpdateSchema } from "@/lib/triage/policy/types";
import { validatePolicySemantics } from "@/lib/triage/policy/validation";

/**
 * GET /api/triage/policies/[id]?customer_id=<id>
 *
 * Requires `triage:read` permission.
 */
export const GET = withAuth(
  async (request, context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) return badCustomerId();
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return forbidden();
    }
    const policyId = await parsePolicyId(context);
    if (policyId === null) return badPolicyId();

    try {
      const row = await getPolicy(customerId, policyId);
      if (!row) return notFound();
      return NextResponse.json({ data: row });
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
 * PATCH /api/triage/policies/[id]?customer_id=<id>
 *
 * Requires `triage:policy:write` permission.
 */
export const PATCH = withAuth(
  async (request, context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) return badCustomerId();
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return forbidden();
    }
    const policyId = await parsePolicyId(context);
    if (policyId === null) return badPolicyId();

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = policyUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json(
        { error: "PATCH body must contain at least one field to update" },
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
      const row = await updatePolicy(customerId, policyId, parsed.data);
      if (!row) return notFound();
      await auditLog.record({
        actor: session.accountId,
        action: "triage.policy.update",
        target: "triage_policy",
        targetId: String(row.id),
        ip: extractClientIp(request),
        sid: session.sessionId,
        customerId,
        details: {
          name: row.name,
          changedFields: Object.keys(parsed.data),
        },
      });
      return NextResponse.json({ data: row });
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

/**
 * DELETE /api/triage/policies/[id]?customer_id=<id>
 *
 * Requires `triage:policy:write` permission.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) return badCustomerId();
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return forbidden();
    }
    const policyId = await parsePolicyId(context);
    if (policyId === null) return badPolicyId();

    try {
      // Capture name for the audit row before the row goes away.
      const existing = await getPolicy(customerId, policyId);
      if (!existing) return notFound();

      const removed = await deletePolicy(customerId, policyId);
      if (!removed) return notFound();

      await auditLog.record({
        actor: session.accountId,
        action: "triage.policy.delete",
        target: "triage_policy",
        targetId: String(policyId),
        ip: extractClientIp(request),
        sid: session.sessionId,
        customerId,
        details: { name: existing.name },
      });
      return NextResponse.json({ success: true });
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
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

async function parsePolicyId(context: {
  params: Promise<Record<string, string>>;
}): Promise<number | null> {
  const { id } = await context.params;
  const policyId = Number(id);
  if (
    !Number.isFinite(policyId) ||
    !Number.isInteger(policyId) ||
    policyId <= 0
  ) {
    return null;
  }
  return policyId;
}

function badCustomerId() {
  return NextResponse.json(
    { error: "Missing or invalid customer_id" },
    { status: 400 },
  );
}

function badPolicyId() {
  return NextResponse.json({ error: "Invalid policy ID" }, { status: 400 });
}

function notFound() {
  return NextResponse.json({ error: "Policy not found" }, { status: 404 });
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
