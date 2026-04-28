import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";
import { getGigantoStatus } from "@/lib/node/server-actions";

/**
 * GET /api/services/external/giganto/status
 *
 * Lightweight reachability probe used by the Status tab and the
 * detail-page service cards (Phase Node-7, #313). The polling hook
 * dispatches this once per cycle (default `NEXT_PUBLIC_NODE_STATUS_POLL_MS`)
 * and maps `{ ok: true }` → "on", any non-2xx → "off". The full
 * `ServiceStatus` payload is intentionally not returned — `useServiceStatus`
 * only needs the binary up/down signal, and a smaller payload keeps the
 * polling chatter cheap.
 *
 * Permission: `services:read`. The route gate is the redundant first
 * line; `getGigantoStatus` re-checks before dispatching.
 *
 * Cache-Control: `no-store`. Each poll must reach the live endpoint;
 * a cached response would let Giganto stay rendered "on" after it has
 * already gone down.
 */
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export const GET = withAuth(
  async (_request, _context, session) => {
    try {
      await getGigantoStatus(session);
      return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
    } catch (err) {
      if (err instanceof ExternalServiceUnavailableError) {
        return NextResponse.json(
          { ok: false, error: "unreachable" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      // Missing-env (`GIGANTO_GRAPHQL_ENDPOINT` not configured) shows
      // up here as a plain `Error("Missing environment variable: …")`.
      // Treat it the same as "unreachable" so the UI renders Off
      // instead of bubbling a 500 to the polling loop on every tick —
      // an unconfigured Giganto endpoint is a deployment fact, not a
      // bug worth alerting on the BFF logs each poll.
      if (
        err instanceof Error &&
        /Missing environment variable/.test(err.message)
      ) {
        return NextResponse.json(
          { ok: false, error: "unconfigured" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      // Any other error (GraphQL `errors[]`, schema mismatch, etc.)
      // also collapses to "off" for the UI, but is surfaced as a
      // generic 500 so it shows up in logs as a real defect rather
      // than being silently swallowed alongside the unreachable case.
      return NextResponse.json(
        { ok: false, error: "internal" },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }
  },
  { requiredPermissions: ["services:read"] },
);
