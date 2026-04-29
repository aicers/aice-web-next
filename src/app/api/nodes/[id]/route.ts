import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  gigantoConfigToToml,
  tivanConfigToToml,
} from "@/lib/node/applied-config-toml";
import {
  extractUpstreamGraphQLMessage,
  mapConflictError,
  serviceKindFromAgentNotFound,
} from "@/lib/node/conflict-patterns";
import { StaleConflictError } from "@/lib/node/draft";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";
import { updateNodeWithAudit } from "@/lib/node/node-create-update";
import { collectSensorNodes } from "@/lib/node/sensor-list";
import {
  getGigantoConfig,
  getNode,
  getNodeAuditMetadata,
  getTivanConfig,
  listAllNodes,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
  removeNodes,
} from "@/lib/node/server-actions";
import type { NodeDraftInput, NodeInput } from "@/lib/node/types";

/**
 * GET /api/nodes/[id]
 *
 * Refetch a single canonical node payload, used by the Edit dialog's
 * stale-conflict reconciliation prompt to refresh the baseline before
 * the user retries (Keep editing) or rehydrate the form after the user
 * elects to discard their local edits (Discard my edits and reload).
 *
 * Externals (Data Store / TI Container) carry only `draft` on the node
 * payload — applied config lives on Giganto / Tivan and has to be
 * fetched separately. The SSR Settings page already does this when the
 * dialog is first opened (see `nodes/(gate)/settings/page.tsx`); the
 * stale-conflict refresh has to repeat the projection here so the
 * dialog re-seeds external sections from the *current* applied
 * baseline rather than the pre-conflict snapshot it opened with.
 * Without this, "Discard my edits and reload" still shows pre-conflict
 * applied values for Data Store / TI Container, and "Keep editing"
 * lets a single touched external field re-serialise the entire section
 * with stale untouched subfields (the section-level preservation in
 * `buildDraftSubmission` only protects sections the user did not touch
 * at all). Each fetch is gated on the node hosting the matching
 * external with `draft: null`; transient unavailability of
 * Giganto/Tivan falls through silently so the refresh still completes
 * and the dialog can decide whether to fall back to its existing seed.
 *
 * Combined `nodes:read + services:read` gate matches `getNode`'s
 * permission contract, since the response carries the same mixed
 * metadata + service-draft surface as the SSR Settings page read.
 *
 * The Hog (Semi-supervised Engine) form's `active_sensors` checklist
 * is rendered against a sensor pool collected from every node hosting
 * a SENSOR agent. The pool can drift between dialog open and the
 * stale-conflict refresh (e.g. a concurrent writer added a new sensor
 * elsewhere), so the refresh must return a fresh pool alongside the
 * canonical node and applied-external baseline. Without this, the
 * dialog would rebuild defaults and serialise Hog against the original
 * pool — and `serialiseSemiSupervised` omits `active_sensors` whenever
 * the selected ids match the supplied pool as a set, which the
 * manager-side deserialise reads as "every sensor in the *current*
 * pool selected", silently selecting sensors the user never saw.
 */
export const GET = withAuth(
  async (_request, context, session) => {
    const { id: nodeId } = await context.params;
    if (!nodeId) {
      return NextResponse.json({ error: "Invalid node id" }, { status: 400 });
    }
    try {
      // Run the node fetch and the sensor-pool walk in parallel; the
      // pool walk re-uses the already-paginated `listAllNodes` so the
      // refresh sees the same `nodes:read + services:read` surface as
      // the SSR Settings page open path.
      const [node, allNodes] = await Promise.all([
        getNode(session, nodeId),
        listAllNodes(session),
      ]);
      const sensorOptions = collectSensorNodes(
        allNodes.edges.map((e) => e.node),
      );
      const appliedExternalDrafts: Record<string, string> = {};
      const externalFetches: Promise<void>[] = [];
      for (const ext of node.externalServices) {
        if (ext.draft !== null) continue;
        if (ext.kind === "DATA_STORE") {
          externalFetches.push(
            getGigantoConfig(session)
              .then((config) => {
                appliedExternalDrafts["data-store"] =
                  gigantoConfigToToml(config);
              })
              .catch((err) => {
                if (!(err instanceof ExternalServiceUnavailableError))
                  throw err;
              }),
          );
        } else if (ext.kind === "TI_CONTAINER") {
          externalFetches.push(
            getTivanConfig(session)
              .then((config) => {
                appliedExternalDrafts["ti-container"] =
                  tivanConfigToToml(config);
              })
              .catch((err) => {
                if (!(err instanceof ExternalServiceUnavailableError))
                  throw err;
              }),
          );
        }
      }
      if (externalFetches.length > 0) await Promise.all(externalFetches);
      return NextResponse.json({ node, appliedExternalDrafts, sensorOptions });
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
  },
  { requiredPermissions: ["nodes:read", "services:read"] },
);

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

interface UpdateNodeBody {
  old: NodeInput;
  new: NodeDraftInput;
}

interface ConflictResponse {
  error: string;
  field: string | null;
  serviceKind?: string;
}

/**
 * PATCH /api/nodes/[id]
 *
 * Save a draft on an existing node. Emits `node.update` (only when
 * metadata fields changed) and any `service.set_mode` audits derived
 * server-side from the persisted before/after agent state; per-service
 * `service.draft_save` entries are emitted by the underlying
 * `saveDraft` (Phase Node-9). Requires both `nodes:write` and
 * `services:write`.
 *
 * Server-reported conflicts are mapped through `mapConflictError` so
 * the dialog can focus the offending field. A double stale-conflict
 * surfaces as 409 with `field: null` so the dialog shows the
 * reconciliation prompt; `agent <key> not found` surfaces as
 * `field: "service"` with the matched `serviceKind` so the dialog can
 * pin the inline error to the affected accordion section.
 */
export const PATCH = withAuth(
  async (request, context, session) => {
    const { id: nodeId } = await context.params;
    if (!nodeId) {
      return NextResponse.json({ error: "Invalid node id" }, { status: 400 });
    }
    let body: UpdateNodeBody;
    try {
      body = (await request.json()) as UpdateNodeBody;
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }
    if (!body || typeof body !== "object" || !body.old || !body.new) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }
    try {
      await updateNodeWithAudit(session, nodeId, body.old, body.new, {
        ip: extractClientIp(request),
      });
      return NextResponse.json({ success: true });
    } catch (err) {
      if (err instanceof StaleConflictError) {
        const payload: ConflictResponse = {
          error: err.message,
          field: null,
        };
        return NextResponse.json(payload, { status: 409 });
      }
      const conflict = mapConflictError(err);
      if (conflict) {
        const payload: ConflictResponse = {
          error: conflict.message,
          field: conflict.field,
        };
        if (conflict.field === "service") {
          const serviceKind = serviceKindFromAgentNotFound(conflict.message);
          if (serviceKind) payload.serviceKind = serviceKind;
        }
        return NextResponse.json(payload, { status: 409 });
      }
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
      // Unmatched but GraphQL-shaped upstream errors fall through to a
      // structured 502 so the dialog footer banner can show the real
      // REview message instead of the generic 500 fallback. The body
      // shape (`field: null`) routes the dialog to `setSubmitError`
      // rather than the stale-conflict prompt (which is reserved for
      // 409 + `field: null`). Anything that does not look like a
      // GraphQLError still bubbles as a real 500 so genuine programming
      // bugs are not papered over.
      const upstream = extractUpstreamGraphQLMessage(err);
      if (upstream !== null) {
        const payload: ConflictResponse = { error: upstream, field: null };
        return NextResponse.json(payload, { status: 502 });
      }
      throw err;
    }
  },
  { requiredPermissions: ["nodes:write", "services:write"] },
);
