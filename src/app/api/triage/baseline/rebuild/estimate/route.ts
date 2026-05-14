import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import {
  CustomerNotFoundError,
  getCustomerPool,
} from "@/lib/triage/policy/customer-db";
import { reviewDetectorRetentionMs } from "@/lib/triage/server-actions";

/**
 * GET /api/triage/baseline/rebuild/estimate
 *    ?customerId=<id>&from=<iso>&to=<iso>
 *
 * Pre-confirm read-only probe for the rebuild flow (#473). Returns:
 *
 *   {
 *     currentTriagedRowCount: number,
 *     warnings: string[]
 *   }
 *
 * - Same auth gate (SystemAdministrator) and customer-access check
 *   as the POST.
 * - Same range validation (`RebuildValidation` on `from >= to`).
 * - **No DB writes, no advisory lock, no `review` fetch** — only a
 *   `COUNT(*)` with the byte-identical predicate the POST's DELETE
 *   uses, plus a comparison of `to` against the detector-store
 *   retention horizon to surface the warning text.
 *
 * The count is a snapshot; if cadence ticks between this GET and the
 * POST, the actual DELETE count may differ slightly. Cosmetic — the
 * UI labels the value as an estimate, and the success toast carries
 * the exact counts.
 */
export const GET = withAuth(async (request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json(
      { error: "Forbidden", code: "Forbidden" },
      { status: 403 },
    );
  }

  const parsed = parseQuery(request);
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

  let pool: Awaited<ReturnType<typeof getCustomerPool>>;
  try {
    pool = await getCustomerPool(parsed.customerId);
  } catch (err) {
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json(
        { error: err.message, code: "RebuildValidation" },
        { status: 400 },
      );
    }
    throw err;
  }

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1 AND event_time < $2`,
    [parsed.fromIso, parsed.toIso],
  );
  const currentTriagedRowCount = Number(rows[0]?.count ?? "0");

  const warnings: string[] = [];
  const detectorRetentionFloor = Date.now() - reviewDetectorRetentionMs();
  if (Date.parse(parsed.toIso) < detectorRetentionFloor) {
    warnings.push(
      "this period may predate the detector store's data; rebuild may result in fewer rows than currently shown",
    );
  }

  return NextResponse.json({ currentTriagedRowCount, warnings });
});

interface ParsedQuery {
  ok: true;
  customerId: number;
  fromIso: string;
  toIso: string;
}
interface ParseError {
  ok: false;
  error: string;
}

function parseQuery(request: NextRequest): ParsedQuery | ParseError {
  const params = request.nextUrl.searchParams;
  const customerIdRaw = params.get("customerId");
  if (customerIdRaw === null) {
    return { ok: false, error: "customerId is required" };
  }
  const customerId = Number(customerIdRaw);
  if (
    !Number.isFinite(customerId) ||
    !Number.isInteger(customerId) ||
    customerId <= 0
  ) {
    return { ok: false, error: "customerId must be a positive integer" };
  }
  const from = params.get("from");
  const to = params.get("to");
  if (from === null || to === null) {
    return { ok: false, error: "from and to are required" };
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
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
    customerId,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

/**
 * Mirror of the POST handler's scope check. The estimate endpoint
 * does no DB writes, but it surfaces a row count for the operator's
 * confirm modal — surfacing counts for a tenant the caller is not
 * single-customer-scoped to would still leak information across
 * tenants, so the same gate applies here. See the POST route for
 * the rationale; behaviour and error codes are identical.
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
