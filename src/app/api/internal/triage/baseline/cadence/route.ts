import "server-only";

import { NextResponse } from "next/server";
import {
  runTriageBaselineCadence,
  verifyTriageBaselineCadenceToken,
} from "@/lib/triage/baseline/cadence";
import { createCadencePager } from "@/lib/triage/baseline/pager";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

/**
 * POST /api/internal/triage/baseline/cadence
 *
 * Internal-token-guarded entrypoint the deployment scheduler uses to
 * drive one hourly cadence pass per customer (1B-1 / discussion #447
 * §3.4). Body shape:
 *
 *     { "customer_id": <number> }
 *
 * Token verification follows the same shape as the apply-attempt
 * cleanup route (`Authorization: Bearer <token>`), with the secret
 * read from `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`. No user session
 * is involved; the runner executes as a system actor against the
 * customer-tenant DB the resolver maps `customer_id` to.
 *
 * Status codes:
 *   - 200 with `{ status, observedInserted, baselineInserted,
 *     lastEventCursor }` when at least one page committed (`status:
 *     'ok'`) or the advisory lock was already held by another
 *     invocation (`status: 'skipped'`).
 *   - 400 when the request body is invalid.
 *   - 401 when the bearer token does not verify.
 *   - 404 when the supplied `customer_id` is unknown / not active.
 *   - 500 with `{ status: 'failed', error }` when a cadence page rolled
 *     back. The route still returns a structured body so the scheduler
 *     can log the error string.
 */

// Lazily-instantiated production pager. Built once per process so the
// graphql-request client and mTLS dispatcher are reused across cadence
// invocations.
let CACHED_PAGER: ReturnType<typeof createCadencePager> | null = null;

function getProductionPager() {
  if (CACHED_PAGER === null) {
    CACHED_PAGER = createCadencePager();
  }
  return CACHED_PAGER;
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageBaselineCadenceToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const customerId = parseCustomerId(body);
  if (customerId === null) {
    return NextResponse.json(
      { error: "Body must be { customer_id: <positive integer> }" },
      { status: 400 },
    );
  }

  try {
    const result = await runTriageBaselineCadence(customerId, {
      pager: getProductionPager(),
    });
    if (result.status === "failed") {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Cadence failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseCustomerId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { customer_id?: unknown }).customer_id;
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw <= 0) return null;
  return raw;
}
