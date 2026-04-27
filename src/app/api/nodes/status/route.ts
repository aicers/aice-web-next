import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { getNodeStatusList } from "@/lib/node/status";

/**
 * GET /api/nodes/status
 *
 * Point-in-time per-node ping + resource snapshot used by the Status
 * tab and the detail-page dashboard. Holds no history and no cache —
 * every call returns the current `nodeStatusList` payload from the
 * manager. The rolling sparkline buffer lives in the client polling
 * hook (`useNodeStatusPolling`), not here.
 *
 * Combined `nodes:read + services:read` gate: the underlying status
 * payload carries per-service snapshots alongside node metadata. The
 * `getNodeStatusList` server action enforces the same combined gate;
 * this route gate is the redundant first line so a missing scope
 * surfaces as 403 before any upstream dispatch runs.
 *
 * Manager-unreachable surfaces as 503; the consumer renders the
 * "Cannot reach manager" panel rather than a blank table.
 *
 * Cache-Control: the freshness contract is point-in-time per call.
 * Setting `no-store` on every response (including the 503) closes
 * the door on browser/CDN/Next.js layers reusing an older payload
 * for a later poll tick — without it we are relying on framework
 * defaults rather than enforcing the contract explicitly.
 */
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export const GET = withAuth(
  async (_request, _context, session) => {
    try {
      const result = await getNodeStatusList(session);
      return NextResponse.json(result, { headers: NO_STORE_HEADERS });
    } catch (err) {
      if (err instanceof ManagerUnavailableError) {
        return NextResponse.json(
          { error: "Manager unavailable" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      throw err;
    }
  },
  { requiredPermissions: ["nodes:read", "services:read"] },
);
