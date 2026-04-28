import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";
import { getTivanStatus } from "@/lib/node/server-actions";

/**
 * GET /api/services/external/tivan/status
 *
 * Tivan twin of `/api/services/external/giganto/status`. See that
 * route's header for the contract. The probe is a thin reachability
 * check — `{ ok: true }` for "on", any non-2xx for "off".
 */
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export const GET = withAuth(
  async (_request, _context, session) => {
    try {
      await getTivanStatus(session);
      return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
    } catch (err) {
      if (err instanceof ExternalServiceUnavailableError) {
        return NextResponse.json(
          { ok: false, error: "unreachable" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      // See the Giganto route for the rationale on the missing-env
      // carve-out — same here for `TIVAN_GRAPHQL_ENDPOINT`.
      if (
        err instanceof Error &&
        /Missing environment variable/.test(err.message)
      ) {
        return NextResponse.json(
          { ok: false, error: "unconfigured" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      return NextResponse.json(
        { ok: false, error: "internal" },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }
  },
  { requiredPermissions: ["services:read"] },
);
