import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import type pg from "pg";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import {
  acquireCustomerCadenceLock,
  executeRetroactiveDelete,
} from "@/lib/triage/exclusion/retroactive-delete";
import {
  connectCustomerClient,
  createCustomerExclusion,
  listCustomerExclusions,
  StoredExclusionConflictError,
} from "@/lib/triage/exclusion/storage";
import {
  type ParsedStoredExclusion,
  parseStoredExclusionInput,
  StoredExclusionValidationError,
} from "@/lib/triage/exclusion/storage-input";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

/**
 * GET /api/triage/exclusions?customer_id=<id>
 *
 * Lists customer-scoped triage exclusions for one customer. Requires
 * `triage:read` plus that the caller's effective customer scope
 * includes `customer_id`.
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
      const rows = await listCustomerExclusions(customerId);
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
 * POST /api/triage/exclusions?customer_id=<id>
 *
 * Creates a customer-scoped exclusion. INSERT and the first DELETE
 * batch share one transaction so a crashed runner cannot leave a row
 * inserted with no DELETE applied. Subsequent batches run in separate
 * transactions; a concurrent cadence tick that sees a partially-cleaned
 * corpus is benign because the new exclusion row is already visible
 * and cadence step (c) applies it forward from that point.
 *
 * Acquires the per-customer cadence advisory lock (blocking variant)
 * before issuing the DELETE so cadence's `pg_try_advisory_xact_lock`
 * exits cleanly and resumes via `last_event_cursor`.
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
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json(
        { error: "Body must be a JSON object" },
        { status: 400 },
      );
    }
    const body = raw as { kind?: unknown; value?: unknown; note?: unknown };

    let parsed: ParsedStoredExclusion;
    try {
      parsed = parseStoredExclusionInput({
        kind: typeof body.kind === "string" ? body.kind : "",
        value: typeof body.value === "string" ? body.value : "",
        note:
          body.note === undefined || body.note === null
            ? null
            : typeof body.note === "string"
              ? body.note
              : "",
      });
    } catch (err) {
      if (err instanceof StoredExclusionValidationError) {
        return NextResponse.json(
          { error: err.message, field: err.field, code: err.code },
          { status: 400 },
        );
      }
      throw err;
    }

    let client: pg.PoolClient;
    try {
      client = await connectCustomerClient(customerId);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }

    try {
      await client.query("BEGIN");
      await acquireCustomerCadenceLock(client, customerId);

      const row = await createCustomerExclusion(
        customerId,
        {
          kind: parsed.kind,
          value: parsed.value,
          domainSuffix: parsed.domainSuffix,
          note: parsed.note,
          createdBy: session.accountId,
        },
        client,
      );

      const counts = await executeRetroactiveDelete(client, {
        kind: parsed.kind,
        value: parsed.value,
        domainSuffix: parsed.domainSuffix,
      });

      await client.query("COMMIT");

      await auditLog.record({
        actor: session.accountId,
        action: "triage_exclusion.customer_add",
        target: "triage_exclusion",
        targetId: row.id,
        ip: extractClientIp(request),
        sid: session.sessionId,
        customerId,
        details: {
          id: row.id,
          kind: row.kind,
          value: row.value,
          deletedCorpusRows: counts,
        },
      });

      return NextResponse.json({ data: row }, { status: 201 });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
      if (err instanceof StoredExclusionConflictError) {
        return NextResponse.json(
          { error: err.message, field: "value", code: "duplicate" },
          { status: 409 },
        );
      }
      throw err;
    } finally {
      client.release();
    }
  },
  { requiredPermissions: ["triage:exclusion:write"] },
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
