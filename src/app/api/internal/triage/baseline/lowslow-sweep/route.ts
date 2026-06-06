import "server-only";

import { NextResponse } from "next/server";

import { runLowslowSweepDispatch } from "@/lib/triage/baseline/lowslow-dispatcher";
import { verifyTriageLowslowSweepToken } from "@/lib/triage/baseline/lowslow-sweep";

/**
 * POST /api/internal/triage/baseline/lowslow-sweep
 *
 * Internal-token-guarded fan-out the in-repo `cron` service hits every
 * hour (issue #701). Enumerates active customers and runs one
 * low-and-slow sweep per customer with bounded concurrency +
 * per-customer timeout. Independent of the 15-minute cadence dispatch
 * (`/dispatch`) — own advisory lock, own `lowslow_finalized_through`
 * watermark, own token.
 *
 * Token: `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN` — a per-surface token
 * isolated from the cadence token so a leaked secret cannot pivot
 * between the cadence and sweep surfaces.
 *
 * Status codes:
 *   - 200 with `{ overall: 'ok' | 'partial', perCustomer: [...] }` when
 *     the dispatcher itself completed. A per-customer failure / timeout
 *     produces `partial` but still 200 — cron retry decisions stay in
 *     the wrapper script.
 *   - 401 when the bearer token does not verify.
 *   - 500 with `{ overall: 'failed', error }` only when the dispatcher
 *     itself fails (e.g. customer enumeration query rejected).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageLowslowSweepToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runLowslowSweepDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatcher failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
