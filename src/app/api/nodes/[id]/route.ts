import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  getNode,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
  removeNodes,
} from "@/lib/node/server-actions";

/**
 * DELETE /api/nodes/[id]
 *
 * Delete a single node. On success, emit a `node.delete` audit entry
 * with `{ hostname }` in `details`. Bulk delete is implemented client-
 * side as N parallel calls so each deletion produces its own entry,
 * matching the per-target audit contract from `decisions/node-permissions.md`.
 *
 * Requires `nodes:delete`. The underlying `removeNodes` server action
 * enforces tenant scope before reaching review-web.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id: nodeId } = await context.params;
    if (!nodeId) {
      return NextResponse.json({ error: "Invalid node id" }, { status: 400 });
    }

    let hostname = "";
    let customerId: number | undefined;
    try {
      const node = await getNode(session, nodeId);
      hostname = node.profile?.hostname ?? node.profileDraft?.hostname ?? "";
      const cid = node.profile?.customerId ?? node.profileDraft?.customerId;
      if (cid !== undefined) customerId = Number(cid);
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

    try {
      await removeNodes(session, [nodeId]);
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

    await auditLog.record({
      actor: session.accountId,
      action: "node.delete",
      target: "node",
      targetId: nodeId,
      details: { hostname },
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["nodes:delete"] },
);
