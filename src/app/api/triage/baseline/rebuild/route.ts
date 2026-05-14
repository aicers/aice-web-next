import "server-only";

import { NextResponse } from "next/server";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  REBUILD_HARD_TIMEOUT_MS,
  RebuildBusyError,
  RebuildIncompleteError,
  RebuildTimeoutError,
  runTriageBaselineRebuild,
} from "@/lib/triage/baseline/rebuild";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

/**
 * POST /api/triage/baseline/rebuild
 *
 * Admin-only force-rebuild of corpus A for a single customer-tenant
 * DB and a single `[from, to)` window (#473). Role gate is
 * `SystemAdministrator` only — no permission bit is consulted, the
 * named-role check enforces the trust boundary the issue spells out.
 *
 * Body (JSON):
 *
 *   { "customerId": number, "from": ISO8601, "to": ISO8601 }
 *
 * Success (HTTP 200, JSON):
 *
 *   {
 *     deletedTriagedRows, deletedObservedRows,
 *     insertedTriagedRows, insertedObservedRows,
 *     durationMs, warnings
 *   }
 *
 * Error codes (JSON `code` field):
 *
 *   - `RebuildValidation` (400) — from > to, from == to, customerId
 *      does not match the caller's single authorized tenant, or the
 *      caller's effective scope spans 2+ customers (multi-tenant
 *      rebuild is out of scope; submit per-tenant).
 *   - `Forbidden` (403) — caller is not SystemAdministrator OR the
 *      caller's effective scope is empty.
 *   - `RebuildBusy` (409) — advisory lock is held by cadence or
 *      another rebuild.
 *   - `RebuildTimeout` (504) — 300s hard cap exceeded.
 *   - `RebuildIncomplete` (504) — review's paginator never reached
 *      `hasNextPage = false` within the safety cap; the corpus was
 *      left untouched. The operator should split the period and
 *      retry rather than DELETE/INSERT a partial slice.
 */
export const POST = withAuth(async (request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json(
      { error: "Forbidden", code: "Forbidden" },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON", code: "RebuildValidation" },
      { status: 400 },
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "Body must be a JSON object", code: "RebuildValidation" },
      { status: 400 },
    );
  }
  const body = raw as { customerId?: unknown; from?: unknown; to?: unknown };

  const parsed = parseRebuildBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, code: "RebuildValidation" },
      { status: 400 },
    );
  }

  const scopeCheck = await authorizeSingleCustomerScope(
    session.accountId,
    session.roles,
    parsed.customerId,
  );
  if (!scopeCheck.ok) {
    return NextResponse.json(
      { error: scopeCheck.error, code: scopeCheck.code },
      { status: scopeCheck.status },
    );
  }

  try {
    const result = await runTriageBaselineRebuild({
      customerId: parsed.customerId,
      fromIso: parsed.fromIso,
      toIso: parsed.toIso,
      signal: request.signal,
    });

    // Audit row — best-effort. A failed write does not fail the
    // mutation; the warning is appended so the caller learns about
    // the audit gap.
    try {
      await auditLog.record({
        actor: session.accountId,
        action: "triage_baseline.rebuild",
        target: "customer",
        targetId: String(parsed.customerId),
        ip: extractClientIp(request),
        sid: session.sessionId,
        customerId: parsed.customerId,
        details: {
          from: parsed.fromIso,
          to: parsed.toIso,
          // #473's operational sequence §6 enumerates `started_at` and
          // `completed_at` alongside the counts. The audit row is the
          // canonical post-hoc record when the originating page
          // unmounts mid-rebuild — keep the timestamps explicit rather
          // than asking readers to back-compute them from `durationMs`.
          startedAt: result.startedAtIso,
          completedAt: result.completedAtIso,
          deletedTriagedRows: result.deletedTriagedRows,
          deletedObservedRows: result.deletedObservedRows,
          insertedTriagedRows: result.insertedTriagedRows,
          insertedObservedRows: result.insertedObservedRows,
          durationMs: result.durationMs,
        },
      });
    } catch (auditErr) {
      const message =
        auditErr instanceof Error ? auditErr.message : String(auditErr);
      // The fallback log is the secondary persistent record when
      // `audit_db` is unreachable, per the issue's audit-failure
      // contract. Mirror the full audit payload (timestamps and both
      // observed/triaged counts) so the structured log line is a
      // drop-in equivalent for the missing audit row.
      console.error(
        "[triage_baseline.rebuild] audit log write failed:",
        message,
        {
          actor: session.accountId,
          customerId: parsed.customerId,
          from: parsed.fromIso,
          to: parsed.toIso,
          startedAt: result.startedAtIso,
          completedAt: result.completedAtIso,
          deletedTriagedRows: result.deletedTriagedRows,
          deletedObservedRows: result.deletedObservedRows,
          insertedTriagedRows: result.insertedTriagedRows,
          insertedObservedRows: result.insertedObservedRows,
          durationMs: result.durationMs,
        },
      );
      result.warnings.push(
        "audit log write failed; see app log for fallback record",
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RebuildBusyError) {
      return NextResponse.json(
        {
          error:
            "cadence or another rebuild is currently writing for this customer; retry shortly",
          code: "RebuildBusy",
        },
        { status: 409 },
      );
    }
    if (err instanceof RebuildTimeoutError) {
      return NextResponse.json(
        {
          error: `Rebuild exceeded the ${REBUILD_HARD_TIMEOUT_MS / 1000}s hard timeout; split the period and retry.`,
          code: "RebuildTimeout",
        },
        { status: 504 },
      );
    }
    if (err instanceof RebuildIncompleteError) {
      return NextResponse.json(
        {
          error: err.message,
          code: "RebuildIncomplete",
          pagesFetched: err.pagesFetched,
        },
        { status: 504 },
      );
    }
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json(
        { error: err.message, code: "RebuildValidation" },
        { status: 400 },
      );
    }
    throw err;
  }
});

interface ParsedBody {
  ok: true;
  customerId: number;
  fromIso: string;
  toIso: string;
}
interface ParseError {
  ok: false;
  error: string;
}

function parseRebuildBody(body: {
  customerId?: unknown;
  from?: unknown;
  to?: unknown;
}): ParsedBody | ParseError {
  const customerIdRaw = body.customerId;
  if (typeof customerIdRaw !== "number" || !Number.isInteger(customerIdRaw)) {
    return { ok: false, error: "customerId must be a positive integer" };
  }
  if (customerIdRaw <= 0) {
    return { ok: false, error: "customerId must be a positive integer" };
  }
  if (typeof body.from !== "string" || typeof body.to !== "string") {
    return { ok: false, error: "from and to must be ISO-8601 strings" };
  }
  const fromMs = Date.parse(body.from);
  const toMs = Date.parse(body.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: "from and to must be parseable timestamps" };
  }
  if (fromMs >= toMs) {
    return {
      ok: false,
      error: "from must be strictly less than to (half-open [from, to))",
    };
  }
  return {
    ok: true,
    customerId: customerIdRaw,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

/**
 * Server-side mirror of the UI's "single-customer scope" gate. The
 * rebuild is intentionally destructive (DELETE + re-INSERT for the
 * named period) and the issue requires `customerId` to *equal* the
 * caller's authorized tenant — not merely to be reachable via
 * `customers:access-all`. The UI hides/disables the button unless the
 * effective scope contains exactly one customer; the server enforces
 * the same precondition so a global System Administrator cannot
 * bypass the UI gate by POSTing a different tenant id.
 *
 * Outcomes:
 *   - empty scope (no `account_customer` rows and not access-all over
 *     a non-empty customer set) → 403 Forbidden;
 *   - 2+ customers in the effective scope → 400 RebuildValidation,
 *     so the caller learns the request is malformed rather than
 *     getting a vague "not allowed";
 *   - exactly one customer that does not match the request body
 *     → 400 RebuildValidation;
 *   - exactly one customer that matches → allowed.
 */
async function authorizeSingleCustomerScope(
  accountId: string,
  roles: string[],
  customerId: number,
): Promise<
  { ok: true } | { ok: false; status: number; code: string; error: string }
> {
  const ids = await resolveEffectiveCustomerIds(accountId, roles);
  if (ids.length === 0) {
    return { ok: false, status: 403, code: "Forbidden", error: "Forbidden" };
  }
  if (ids.length !== 1) {
    return {
      ok: false,
      status: 400,
      code: "RebuildValidation",
      error: `rebuild requires a single-customer scope; caller is authorized for ${ids.length} customers`,
    };
  }
  if (ids[0] !== customerId) {
    return {
      ok: false,
      status: 400,
      code: "RebuildValidation",
      error: `customerId ${customerId} does not match the caller's authorized customer ${ids[0]}`,
    };
  }
  return { ok: true };
}
