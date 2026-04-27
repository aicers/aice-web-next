import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  getNodeAuditMetadata,
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
 * Requires `nodes:delete` only. The audit metadata pre-fetch routes
 * through `getNodeAuditMetadata`, which is permissioned strictly on
 * `nodes:delete` — using `getNode` here would force every custom role
 * with `nodes:delete` to also hold `nodes:read + services:read` (the
 * combined-gate rule for the full mixed-surface read), which the
 * permission decision does not require. The underlying `removeNodes`
 * server action enforces tenant scope before reaching review-web.
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
      const node = await getNodeAuditMetadata(session, nodeId);
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

    let deletedIds: string[];
    try {
      deletedIds = await removeNodes(session, [nodeId]);
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

    // Failed deletes must not emit an audit entry (Phase Node-3
    // acceptance). The manager mutation can resolve successfully but
    // return a subset / empty `removeNodes` list — for example if the
    // node was already gone or the manager refused the id post-scope-
    // check. Treat absence from the deleted-id list as a failure.
    if (!deletedIds.includes(nodeId)) {
      return NextResponse.json(
        { error: "Node was not deleted" },
        { status: 409 },
      );
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
