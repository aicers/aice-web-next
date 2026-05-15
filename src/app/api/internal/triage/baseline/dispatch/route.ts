import "server-only";

import { NextResponse } from "next/server";

import { verifyTriageBaselineCadenceToken } from "@/lib/triage/baseline/cadence";
import { runTriageBaselineDispatch } from "@/lib/triage/baseline/dispatcher";
import { createCadencePager } from "@/lib/triage/baseline/pager";
import { STORAGE_EXCLUSION_SET_RESOLVER } from "@/lib/triage/exclusion/active-set-storage";

/**
 * POST /api/internal/triage/baseline/dispatch
 *
 * Internal-token-guarded fan-out the in-repo `cron` service hits
 * every 15 minutes. Enumerates active customers and runs one cadence
 * pass per customer with bounded concurrency + per-customer timeout.
 * The per-customer route (`/cadence`) stays unchanged — operators can
 * still POST `{customer_id: N}` for a single-customer manual run.
 *
 * Token: shares
 * `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN` with the per-customer
 * cadence route. The dispatcher and per-customer endpoints both run
 * as system actors against the same cadence runner; a separate token
 * would only add operational moving parts without isolating any
 * privilege boundary.
 *
 * Status codes:
 *   - 200 with `{ overall: 'ok' | 'partial', perCustomer: [...] }` when
 *     the dispatcher itself completed. A per-customer failure / timeout
 *     produces `partial` but still 200 — cron retry decisions stay
 *     centralised in the wrapper script (see `infra/cron/`).
 *   - 401 when the bearer token does not verify.
 *   - 500 with `{ overall: 'failed', error }` only when the dispatcher
 *     itself fails (e.g. customer enumeration query rejected).
 */

let CACHED_PAGER: ReturnType<typeof createCadencePager> | null = null;

function getProductionPager() {
  if (CACHED_PAGER === null) {
    // Wire the storage-backed resolver so the dispatched cadence pass
    // sees newly-created exclusions (#457) and snapshots the actual
    // `global ∪ customer` set (#472). Defaulting to
    // `EMPTY_EXCLUSION_SET_RESOLVER` would silently admit events that
    // should be excluded and persist an empty `exclusion_snapshot` row
    // for the empty-set fingerprint, breaking #472's audit invariant.
    CACHED_PAGER = createCadencePager({
      resolver: STORAGE_EXCLUSION_SET_RESOLVER,
    });
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

  try {
    const result = await runTriageBaselineDispatch({
      pager: getProductionPager(),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatcher failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
