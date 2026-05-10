import "server-only";

import { NextResponse } from "next/server";

/**
 * GET /api/health
 *
 * Cheap liveness probe for the in-repo `cron` service to gate hourly
 * dispatcher firings on (see #487 §1 readiness gate). The handler does
 * NOT touch the database, dispatch to upstreams, or do any auth work
 * — it returns immediately so the compose healthcheck stays
 * lightweight and a failing dependency cannot mask the readiness
 * signal.
 *
 * Anything that needs a deeper check (DB connectivity, upstream mTLS,
 * etc.) should land on a separate route; this one is reserved for the
 * "is the Next.js process accepting requests?" question.
 */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true });
}
