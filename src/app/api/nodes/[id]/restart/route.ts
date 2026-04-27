import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
  restartNode,
} from "@/lib/node/status";

/**
 * POST /api/nodes/[id]/restart
 *
 * Restart the node identified by `[id]`. Requires `nodes:write`. The
 * hostname is resolved server-side from the canonical node payload, so
 * a forged hostname in the request body cannot bypass the BFF tenant-
 * scope check. On success, emits one `node.restart` audit entry with
 * `{ hostname }` in `details`.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id: nodeId } = await context.params;
    if (!nodeId) {
      return NextResponse.json({ error: "Invalid node id" }, { status: 400 });
    }
    try {
      await restartNode(session, nodeId, { ip: extractClientIp(request) });
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return NextResponse.json({ error: "Node not found" }, { status: 404 });
      }
      if (err instanceof NodePermissionError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (err instanceof ManagerUnavailableError) {
        return NextResponse.json(
          { error: "Manager unavailable" },
          { status: 503 },
        );
      }
      throw err;
    }
    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["nodes:write"] },
);
