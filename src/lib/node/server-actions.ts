import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { graphqlRequest } from "@/lib/graphql/client";
import { gigantoClient, tivanClient } from "@/lib/graphql/external-client";

import {
  assertNodeInScope,
  buildDispatchContext,
  type DispatchContext,
} from "./dispatch-context";
import {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
} from "./errors";
import {
  APPLY_NODE_MUTATION,
  GIGANTO_CONFIG_QUERY,
  GIGANTO_STATUS_QUERY,
  GIGANTO_UPDATE_CONFIG_MUTATION,
  INSERT_NODE_MUTATION,
  NODE_DETAIL_QUERY,
  NODE_LIST_QUERY,
  NODE_REBOOT_MUTATION,
  NODE_SHUTDOWN_MUTATION,
  NODE_STATUS_LIST_QUERY,
  REMOVE_NODES_MUTATION,
  TIVAN_CONFIG_QUERY,
  TIVAN_STATUS_QUERY,
  TIVAN_UPDATE_CONFIG_MUTATION,
  UPDATE_NODE_DRAFT_MUTATION,
} from "./queries";
import type {
  AgentDraftInput,
  ApplyNodeResult,
  ExternalServiceInput,
  GigantoConfig,
  GigantoConfigResult,
  GigantoStatusResult,
  GigantoUpdateConfigResult,
  InsertNodeResult,
  Node as ManagerNode,
  NodeConnection,
  NodeDetailResult,
  NodeDraftInput,
  NodeInput,
  NodeListResult,
  NodeRebootResult,
  NodeShutdownResult,
  NodeStatusConnection,
  NodeStatusListResult,
  RemoveNodesResult,
  ServiceStatus,
  TivanConfig,
  TivanConfigResult,
  TivanStatusResult,
  TivanUpdateConfigResult,
} from "./types";

// ── Permission strings (Phase Node-1) ─────────────────────────────

const NODES_READ = "nodes:read";
const NODES_WRITE = "nodes:write";
const NODES_DELETE = "nodes:delete";
const SERVICES_READ = "services:read";
const SERVICES_WRITE = "services:write";

async function requirePermission(
  session: AuthSession,
  permission: string,
): Promise<void> {
  if (!(await hasPermission(session.roles, permission))) {
    throw new NodePermissionError(`Caller lacks the ${permission} permission.`);
  }
}

// ── Manager error mapping ─────────────────────────────────────────

/**
 * Connection-level failures (refused, DNS, mTLS) and aborts surface
 * as `TypeError` / `AbortError` from undici. These are remapped to
 * {@link ManagerUnavailableError} so the UI can render the
 * manager-offline banner. GraphQL-validation or business-logic errors
 * (returned in the `errors[]` payload of a 200 response) propagate
 * unchanged because they describe a malformed query, not an
 * unreachable backend.
 */
function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof TypeError) return true;
  const code = (error as { code?: string }).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT"
  ) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isConnectionError(cause);
  return false;
}

async function withManagerErrorMapping<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isConnectionError(err)) {
      throw new ManagerUnavailableError(
        "Could not reach the manager (review-web) endpoint.",
        { cause: err },
      );
    }
    throw err;
  }
}

async function withExternalErrorMapping<T>(
  serviceKind: "DATA_STORE" | "TI_CONTAINER",
  promise: Promise<T>,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isConnectionError(err)) {
      throw new ExternalServiceUnavailableError(
        serviceKind,
        `Could not reach the ${
          serviceKind === "DATA_STORE" ? "Giganto" : "Tivan"
        } endpoint.`,
        { cause: err },
      );
    }
    throw err;
  }
}

// ── Manager server actions ────────────────────────────────────────

interface NodeListVariables extends Record<string, unknown> {
  first: number | null;
  after: string | null;
  last: number | null;
  before: string | null;
}

export interface NodePageArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

/**
 * Page the manager's `nodeList`. Tenant scope is applied by review-web
 * from the Context JWT — the BFF only enforces the empty-scope
 * boundary at `buildDispatchContext` and lets review-web filter the
 * connection accordingly. Returned nodes are NOT re-checked against
 * the caller's scope here because the manager has already filtered
 * them; per-node mutations call `assertNodeInScope` directly.
 */
export async function listNodes(
  session: AuthSession,
  args: NodePageArgs = {},
  signal?: AbortSignal,
): Promise<NodeConnection> {
  await requirePermission(session, NODES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<NodeListResult, NodeListVariables>(
      NODE_LIST_QUERY,
      {
        first: args.first ?? null,
        after: args.after ?? null,
        last: args.last ?? null,
        before: args.before ?? null,
      },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.nodeList;
}

interface NodeDetailVariables extends Record<string, unknown> {
  id: string;
}

/**
 * Fetch a single node by id.
 *
 * The defense-in-depth scope check applies after review-web has
 * already filtered the query: review-web returns null/error if the
 * node is out of scope, but a Tenant Administrator with
 * `customer_ids = [5]` calling `getNode("node-belonging-to-7")` must
 * not see customer 7's node even if review-web were ever to widen its
 * own scoping. Phase Node-9's stale-conflict replay calls this on
 * every retry, so the BFF check guards the read regardless of
 * which review-web build is on the other side.
 */
export async function getNode(
  session: AuthSession,
  id: string,
  signal?: AbortSignal,
): Promise<ManagerNode> {
  await requirePermission(session, NODES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<NodeDetailResult, NodeDetailVariables>(
      NODE_DETAIL_QUERY,
      { id },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  if (!data.node) {
    throw new NodeNotFoundError(`Node ${id} was not found.`);
  }
  enforceNodeScope(ctx, data.node);
  return data.node;
}

function enforceNodeScope(ctx: DispatchContext, node: ManagerNode): void {
  // The profile field is null for nodes whose draft has never been
  // applied; in that case there is no committed customer to check
  // against. The draft profile is the only scope signal then. If the
  // node carries no scope at all we conservatively allow only System
  // Administrators through.
  const customerId = node.profile?.customerId ?? node.profileDraft?.customerId;
  if (customerId === undefined) {
    if (ctx.role === "System Administrator") return;
    throw new NodePermissionError(
      "Node carries no customer scope; only System Administrators can read it.",
    );
  }
  assertNodeInScope(ctx, Number(customerId));
}

export async function listNodeStatuses(
  session: AuthSession,
  args: NodePageArgs = {},
  signal?: AbortSignal,
): Promise<NodeStatusConnection> {
  await requirePermission(session, NODES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<NodeStatusListResult, NodeListVariables>(
      NODE_STATUS_LIST_QUERY,
      {
        first: args.first ?? null,
        after: args.after ?? null,
        last: args.last ?? null,
        before: args.before ?? null,
      },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.nodeStatusList;
}

interface InsertNodeVariables extends Record<string, unknown> {
  name: string;
  customerId: string;
  description: string;
  hostname: string;
  agents: AgentDraftInput[];
  externalServices: ExternalServiceInput[];
}

export interface InsertNodeArgs extends Record<string, unknown> {
  name: string;
  customerId: string;
  description: string;
  hostname: string;
  agents: AgentDraftInput[];
  externalServices: ExternalServiceInput[];
}

export async function insertNode(
  session: AuthSession,
  args: InsertNodeArgs,
  signal?: AbortSignal,
): Promise<string> {
  await requirePermission(session, NODES_WRITE);
  const ctx = await buildDispatchContext(session);
  assertNodeInScope(ctx, Number(args.customerId));
  const data = await withManagerErrorMapping(
    graphqlRequest<InsertNodeResult, InsertNodeVariables>(
      INSERT_NODE_MUTATION,
      args,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.insertNode;
}

interface UpdateNodeDraftVariables extends Record<string, unknown> {
  id: string;
  old: NodeInput;
  new: NodeDraftInput;
}

export async function updateNodeDraft(
  session: AuthSession,
  id: string,
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
  signal?: AbortSignal,
): Promise<string> {
  await requirePermission(session, NODES_WRITE);
  const ctx = await buildDispatchContext(session);
  // Defense-in-depth: enforce scope against both the current
  // committed profile (if any) and the proposed draft profile, so a
  // Tenant Administrator cannot rewrite a node into a different
  // customer's tenancy.
  const oldCustomer = oldNode.profile?.customerId;
  if (oldCustomer !== undefined) assertNodeInScope(ctx, Number(oldCustomer));
  const newCustomer = newDraft.profileDraft?.customerId;
  if (newCustomer !== undefined) assertNodeInScope(ctx, Number(newCustomer));
  const data = await withManagerErrorMapping(
    graphqlRequest<{ updateNodeDraft: string }, UpdateNodeDraftVariables>(
      UPDATE_NODE_DRAFT_MUTATION,
      { id, old: oldNode, new: newDraft },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.updateNodeDraft;
}

interface RemoveNodesVariables extends Record<string, unknown> {
  ids: string[];
}

export async function removeNodes(
  session: AuthSession,
  ids: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  await requirePermission(session, NODES_DELETE);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<RemoveNodesResult, RemoveNodesVariables>(
      REMOVE_NODES_MUTATION,
      { ids },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.removeNodes;
}

interface ApplyNodeVariables extends Record<string, unknown> {
  id: string;
  node: NodeInput;
}

/**
 * Apply a node's pending draft to the canonical NodeInput shape. The
 * caller is responsible for assembling `node` (typically by composing
 * the existing applied state with the new draft); Phase Node-9 owns
 * the bulk-apply orchestration that follows up an `applyNode` with
 * the per-service `updateConfig` dispatches.
 */
export async function applyNode(
  session: AuthSession,
  id: string,
  node: NodeInput,
  signal?: AbortSignal,
): Promise<string> {
  await requirePermission(session, NODES_WRITE);
  const ctx = await buildDispatchContext(session);
  if (node.profile?.customerId !== undefined) {
    assertNodeInScope(ctx, Number(node.profile.customerId));
  }
  if (node.profileDraft?.customerId !== undefined) {
    assertNodeInScope(ctx, Number(node.profileDraft.customerId));
  }
  const data = await withManagerErrorMapping(
    graphqlRequest<ApplyNodeResult, ApplyNodeVariables>(
      APPLY_NODE_MUTATION,
      { id, node },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.applyNode;
}

interface NodeRebootVariables extends Record<string, unknown> {
  hostname: string;
}

/**
 * Note: `nodeReboot` and `nodeShutdown` take `hostname: String!` (not
 * an id). Callers typically resolve the hostname from a Node payload
 * and pass it through; the BFF cannot enforce scope on hostname alone
 * because the manager looks the node up by hostname server-side, so
 * permissioning relies on `nodes:write` plus the manager's own
 * customer-scope filter.
 */
export async function nodeReboot(
  session: AuthSession,
  hostname: string,
  signal?: AbortSignal,
): Promise<string> {
  await requirePermission(session, NODES_WRITE);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<NodeRebootResult, NodeRebootVariables>(
      NODE_REBOOT_MUTATION,
      { hostname },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.nodeReboot;
}

export async function nodeShutdown(
  session: AuthSession,
  hostname: string,
  signal?: AbortSignal,
): Promise<string> {
  await requirePermission(session, NODES_WRITE);
  const ctx = await buildDispatchContext(session);
  const data = await withManagerErrorMapping(
    graphqlRequest<NodeShutdownResult, NodeRebootVariables>(
      NODE_SHUTDOWN_MUTATION,
      { hostname },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.nodeShutdown;
}

// ── External-service server actions (Giganto + Tivan) ────────────

/**
 * The two external `updateConfig` dispatches and their `status` /
 * `config` reads. v1 does not expose a per-service apply abstraction —
 * Phase Node-9's bulk-apply orchestrator drives these as direct
 * follow-ups to `applyNode`. Adding a `saveDraft` / `apply` keyed on
 * `serviceKind` here would suggest a per-service capability that
 * does not exist in v1; that abstraction lands uniformly across all
 * service kinds with Phase Node-12 (#333).
 *
 * Tenant scope: external endpoints are global per deployment
 * (one Giganto, one Tivan) so there is no node-level customer scope
 * to enforce here. Callers must already hold `services:read` /
 * `services:write` (Phase Node-1), and the manager-side gate at the
 * orchestration layer checks that the node carrying the service is
 * in the caller's scope before this action runs.
 */

export async function getGigantoStatus(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<ServiceStatus> {
  await requirePermission(session, SERVICES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<GigantoStatusResult>(
      GIGANTO_STATUS_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.status;
}

export async function getGigantoConfig(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<GigantoConfig> {
  await requirePermission(session, SERVICES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<GigantoConfigResult>(
      GIGANTO_CONFIG_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.config;
}

interface UpdateConfigVariables extends Record<string, unknown> {
  old: string;
  new: string;
}

export async function updateGigantoConfig(
  session: AuthSession,
  oldConfig: string,
  newConfig: string,
  signal?: AbortSignal,
): Promise<GigantoConfig> {
  await requirePermission(session, SERVICES_WRITE);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<GigantoUpdateConfigResult, UpdateConfigVariables>(
      GIGANTO_UPDATE_CONFIG_MUTATION,
      { old: oldConfig, new: newConfig },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.updateConfig;
}

export async function getTivanStatus(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<ServiceStatus> {
  await requirePermission(session, SERVICES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "TI_CONTAINER",
    tivanClient<TivanStatusResult>(
      TIVAN_STATUS_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.status;
}

export async function getTivanConfig(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<TivanConfig> {
  await requirePermission(session, SERVICES_READ);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "TI_CONTAINER",
    tivanClient<TivanConfigResult>(
      TIVAN_CONFIG_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.config;
}

export async function updateTivanConfig(
  session: AuthSession,
  oldConfig: string,
  newConfig: string,
  signal?: AbortSignal,
): Promise<TivanConfig> {
  await requirePermission(session, SERVICES_WRITE);
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "TI_CONTAINER",
    tivanClient<TivanUpdateConfigResult, UpdateConfigVariables>(
      TIVAN_UPDATE_CONFIG_MUTATION,
      { old: oldConfig, new: newConfig },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return data.updateConfig;
}

// Re-export the error types so callers can import them from a single
// module entry point.
export {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
};
