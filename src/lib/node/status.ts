import "server-only";

import { auditLog } from "@/lib/audit/logger";
import type { AuthSession } from "@/lib/auth/jwt";

import {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
} from "./errors";
import {
  getNodeControlMetadata,
  listAllNodeStatuses,
  nodeReboot,
  nodeShutdown,
} from "./server-actions";
import type { NodeStatus } from "./types";

// ── Polling configuration ─────────────────────────────────────────

/**
 * Number of samples retained in the client-side rolling buffer that
 * backs the detail-page sparkline. The buffer lives on the client
 * (`useNodeStatusPolling`); this constant is exported here to keep all
 * polling-related configuration in one module.
 */
export const NODE_STATUS_SPARKLINE_SAMPLES = 60;

/**
 * Default polling interval (ms) for the Status tab and detail-page
 * dashboard. `NEXT_PUBLIC_NODE_STATUS_POLL_MS` overrides this; values
 * outside `[NODE_STATUS_POLL_MS_MIN, NODE_STATUS_POLL_MS_MAX]` clamp.
 */
export const NODE_STATUS_POLL_MS_DEFAULT = 10_000;
export const NODE_STATUS_POLL_MS_MIN = 5_000;
export const NODE_STATUS_POLL_MS_MAX = 300_000;

export function clampPollIntervalMs(raw: unknown): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return NODE_STATUS_POLL_MS_DEFAULT;
  if (parsed < NODE_STATUS_POLL_MS_MIN) return NODE_STATUS_POLL_MS_MIN;
  if (parsed > NODE_STATUS_POLL_MS_MAX) return NODE_STATUS_POLL_MS_MAX;
  return parsed;
}

// ── Status query ─────────────────────────────────────────────────

export interface NodeStatusListResult {
  capturedAt: string;
  edges: NodeStatus[];
}

/**
 * Point-in-time snapshot of every node the caller can see. Holds no
 * history and no cache — every call dispatches a fresh `nodeStatusList`
 * to the manager. The rolling buffer that powers the sparkline lives on
 * the client (`useNodeStatusPolling`).
 */
export async function getNodeStatusList(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<NodeStatusListResult> {
  const conn = await listAllNodeStatuses(session, signal);
  return {
    capturedAt: new Date().toISOString(),
    edges: conn.edges.map((edge) => edge.node),
  };
}

// ── Node control actions ─────────────────────────────────────────

interface NodeControlOptions {
  /** Optional client IP forwarded to the audit entry. */
  ip?: string;
}

async function resolveControlContext(
  session: AuthSession,
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ hostname: string; customerId: number | undefined }> {
  // The control path is gated on `nodes:write` only — the issue
  // contract explicitly says so, and the slim metadata fetch keeps
  // that contract honest. Routing through `getNode` (which enforces
  // the combined `nodes:read + services:read` gate over the full
  // mixed-surface payload) would 403 a custom role that legitimately
  // holds `nodes:write` without the read pair. `getNodeControlMetadata`
  // selects only the hostname/customerId fields and is permissioned
  // strictly on `nodes:write`, mirroring the per-action carve-out the
  // delete path uses for its `node.delete` audit metadata.
  const node = await getNodeControlMetadata(session, nodeId, signal);
  const hostname = node.profile?.hostname ?? node.profileDraft?.hostname ?? "";
  const cid = node.profile?.customerId ?? node.profileDraft?.customerId;
  return {
    hostname,
    customerId: cid !== undefined ? Number(cid) : undefined,
  };
}

/**
 * Restart the node identified by `nodeId`. Requires `nodes:write` (the
 * underlying `nodeReboot` server action enforces this). The hostname is
 * resolved from the node id internally so the caller cannot smuggle a
 * forged hostname past the BFF tenant-scope check. Emits one
 * `node.restart` audit entry on success; failures emit no audit.
 */
export async function restartNode(
  session: AuthSession,
  nodeId: string,
  opts: NodeControlOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const { hostname, customerId } = await resolveControlContext(
    session,
    nodeId,
    signal,
  );
  await nodeReboot(session, hostname, signal);
  await auditLog.record({
    actor: session.accountId,
    action: "node.restart",
    target: "node",
    targetId: nodeId,
    details: { hostname },
    ip: opts.ip,
    sid: session.sessionId,
    customerId,
  });
}

/**
 * Shut down the node identified by `nodeId`. Requires `nodes:write`
 * (the underlying `nodeShutdown` server action enforces this). The
 * hostname is resolved from the node id internally. Emits one
 * `node.shutdown` audit entry on success; failures emit no audit.
 */
export async function shutdownNode(
  session: AuthSession,
  nodeId: string,
  opts: NodeControlOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const { hostname, customerId } = await resolveControlContext(
    session,
    nodeId,
    signal,
  );
  await nodeShutdown(session, hostname, signal);
  await auditLog.record({
    actor: session.accountId,
    action: "node.shutdown",
    target: "node",
    targetId: nodeId,
    details: { hostname },
    ip: opts.ip,
    sid: session.sessionId,
    customerId,
  });
}

export {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
};
