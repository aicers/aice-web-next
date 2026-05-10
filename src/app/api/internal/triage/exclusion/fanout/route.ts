import "server-only";

import { NextResponse } from "next/server";

import {
  runFanoutSweep,
  verifyFanoutToken,
} from "@/lib/triage/exclusion/fanout-worker";

/**
 * POST /api/internal/triage/exclusion/fanout
 *
 * Drives one fanout sweep: stuck-job recovery → claim → per-customer
 * retroactive DELETE. Designed to be invoked by the deployment
 * scheduler at a minute-scale cadence.
 *
 * Internal-token guarded: the request must carry
 * `Authorization: Bearer <TRIAGE_EXCLUSION_FANOUT_TOKEN>` matching the
 * env var. The shared secret is constant-time-compared.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyFanoutToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runFanoutSweep();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sweep failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
