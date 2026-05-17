import "server-only";

import { NextResponse } from "next/server";

import {
  runManualMintRetentionDispatch,
  verifyAimerPhase2ManualMintRetentionToken,
} from "@/lib/aimer/phase2/manual-mint-retention";

/**
 * POST /api/internal/aimer/phase2/manual-mint/retention
 *
 * Token-protected entrypoint the deployment scheduler hits daily to
 * sweep `aimer_phase2_manual_mint` rows older than 24h (consumed or
 * not). The manual Send path INSERTs one ledger row per build-envelope
 * call; abandoned sends would otherwise grow this table unbounded.
 *
 * Status codes mirror the triage retention routes: 200 on dispatcher
 * success even when one customer's sweep failed, 401 on token
 * mismatch, 500 only on dispatcher self-failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyAimerPhase2ManualMintRetentionToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runManualMintRetentionDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retention failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
