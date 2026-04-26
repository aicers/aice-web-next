import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { graphqlRequest } from "@/lib/graphql/client";
import { gigantoClient, tivanClient } from "@/lib/graphql/external-client";

import {
  assertNodeInScope,
  buildDispatchContext,
  type DispatchContext,
  SYSTEM_ADMINISTRATOR,
} from "./dispatch-context";
import {
  withExternalErrorMapping,
  withManagerErrorMapping,
  withNodeNotFoundMapping,
} from "./error-mapping";
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

/**
 * Reject the caller with `NodePermissionError` unless every permission
 * in `permissions` is granted by the caller's roles.
 *
 * Why both gates: Node management surfaces are *mixed-surface* — every
 * page and every write path traverses both node and service data
 * (Phase Node-1, `decisions/node-permissions.md` page-combination
 * rule). A caller holding only one half (e.g. `nodes:read` without
 * `services:read`) would otherwise read service draft / config off
 * the same Node payload through this BFF. The strict combined gate
 * here mirrors the per-page rule so a custom role missing a half
 * cannot side-step it via the server-action API.
 */
async function requireAllPermissions(
  session: AuthSession,
  permissions: readonly string[],
): Promise<void> {
  for (const permission of permissions) {
    if (!(await hasPermission(session.roles, permission))) {
      throw new NodePermissionError(
        `Caller lacks the ${permission} permission.`,
      );
    }
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
 * Fetch the canonical Node by id from review-web. Used as the
 * authoritative tenant-scope source for write/apply paths so a caller
 * cannot smuggle an in-scope `customerId` in the request payload while
 * targeting an out-of-scope `id` (the BFF must never trust the payload
 * for the scope decision). Returns the Node payload so the caller can
 * also use it for any other authoritative checks.
 *
 * Error mapping order: not-found before manager-unavailable. Review-web
 * declares `node(id: ID!): Node!` as non-nullable, so a missing id
 * surfaces as a rejected `graphql-request` promise carrying GraphQL
 * errors (NOT as `{ node: null }`). The not-found mapper inspects the
 * thrown error's `response.errors[]` and is a no-op for connection
 * failures, so the manager-unavailable mapper still catches transport
 * errors after it.
 */
async function fetchCanonicalNode(
  ctx: DispatchContext,
  id: string,
  signal?: AbortSignal,
): Promise<ManagerNode> {
  const data = await withManagerErrorMapping(
    withNodeNotFoundMapping(
      graphqlRequest<NodeDetailResult, { id: string }>(
        NODE_DETAIL_QUERY,
        { id },
        { role: ctx.role, customerIds: ctx.customerIds },
        signal,
      ),
      id,
    ),
  );
  // Defense-in-depth: should be unreachable because review-web's
  // schema makes `node` non-nullable, but if a future schema change
  // were to widen it, this check still surfaces the 404 cleanly.
  if (!data.node) {
    throw new NodeNotFoundError(`Node ${id} was not found.`);
  }
  return data.node;
}

/**
 * Authoritative tenant-scope check keyed on a node id. Fetches the
 * canonical Node from review-web and asserts its committed (or
 * draft-only) profile is in the caller's scope. System Administrators
 * skip the round-trip — `assertNodeInScope` is a no-op for them, and
 * write paths that target a known-bad id will still surface the
 * upstream's own error.
 */
async function assertCanonicalNodeInScope(
  ctx: DispatchContext,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (ctx.role === SYSTEM_ADMINISTRATOR) return;
  const node = await fetchCanonicalNode(ctx, id, signal);
  enforceNodeScope(ctx, node);
}

/**
 * Page the manager's `nodeList`. Tenant scope is applied by review-web
 * from the Context JWT — the BFF only enforces the empty-scope
 * boundary at `buildDispatchContext` and lets review-web filter the
 * connection accordingly. Returned nodes are NOT re-checked against
 * the caller's scope here because the manager has already filtered
 * them; per-node mutations call `assertCanonicalNodeInScope` directly.
 *
 * Combined `nodes:read + services:read` gate: the `nodeList` payload
 * carries both node metadata and service draft/config off `agents[]`
 * and `externalServices[]`, so a caller holding only one of the two
 * scopes would still see the full mixed surface without the combined
 * check. See `decisions/node-permissions.md` page-combination rule.
 */
export async function listNodes(
  session: AuthSession,
  args: NodePageArgs = {},
  signal?: AbortSignal,
): Promise<NodeConnection> {
  await requireAllPermissions(session, [NODES_READ, SERVICES_READ]);
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
 *
 * Combined `nodes:read + services:read` gate: the `node` payload
 * carries service draft/config alongside node metadata, so both
 * scopes are required to reach this surface (Phase Node-1).
 */
export async function getNode(
  session: AuthSession,
  id: string,
  signal?: AbortSignal,
): Promise<ManagerNode> {
  await requireAllPermissions(session, [NODES_READ, SERVICES_READ]);
  const ctx = await buildDispatchContext(session);
  const node = await fetchCanonicalNode(ctx, id, signal);
  enforceNodeScope(ctx, node);
  return node;
}

function enforceNodeScope(ctx: DispatchContext, node: ManagerNode): void {
  // The profile field is null for nodes whose draft has never been
  // applied; in that case there is no committed customer to check
  // against. The draft profile is the only scope signal then. If the
  // node carries no scope at all we conservatively allow only System
  // Administrators through.
  const customerId = node.profile?.customerId ?? node.profileDraft?.customerId;
  if (customerId === undefined) {
    if (ctx.role === SYSTEM_ADMINISTRATOR) return;
    throw new NodePermissionError(
      "Node carries no customer scope; only System Administrators can read it.",
    );
  }
  assertNodeInScope(ctx, Number(customerId));
}

/**
 * Page the manager's `nodeStatusList`. Same combined-gate rationale
 * as `listNodes` — the status payload carries per-service `agents[]`
 * and `externalServices[]` snapshots, so both `nodes:read` and
 * `services:read` are required.
 */
export async function listNodeStatuses(
  session: AuthSession,
  args: NodePageArgs = {},
  signal?: AbortSignal,
): Promise<NodeStatusConnection> {
  await requireAllPermissions(session, [NODES_READ, SERVICES_READ]);
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

// Cap the cursor walk so a misbehaving manager (no-op cursor, missing
// `hasNextPage: false`) cannot hang the page indefinitely. 50 pages at
// `pageSize: 200` covers up to 10k nodes — well above any realistic
// deployment; the cap exists strictly as a runaway guard.
const PAGINATION_PAGE_LIMIT = 50;
const DEFAULT_PAGE_SIZE = 200;

/**
 * Walk every page of a connection-shaped manager query, accumulating
 * the edges into a single connection. The list page renders every node
 * the caller can see, so a single `first: N` window would silently drop
 * tail nodes once N is exceeded. The Phase Node-2 `listNodes` /
 * `listNodeStatuses` helpers stay single-page (callers like the detail
 * page or polling hook may want one window only); this helper layers
 * pagination on top.
 */
async function paginate<T>(
  pageFetcher: (args: NodePageArgs) => Promise<{
    edges: T[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    totalCount: string;
  }>,
  pageSize: number,
): Promise<{ edges: T[]; totalCount: string }> {
  const aggregated: T[] = [];
  let cursor: string | null = null;
  let totalCount = "0";
  for (let i = 0; i < PAGINATION_PAGE_LIMIT; i += 1) {
    const page: {
      edges: T[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount: string;
    } = await pageFetcher({
      first: pageSize,
      ...(cursor !== null ? { after: cursor } : {}),
    });
    aggregated.push(...page.edges);
    totalCount = page.totalCount;
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      return { edges: aggregated, totalCount };
    }
    cursor = page.pageInfo.endCursor;
  }
  return { edges: aggregated, totalCount };
}

/**
 * Page through `nodeList` until every node is loaded. Returns a
 * connection-shaped result so existing consumers (`buildNodeRows`)
 * keep working unchanged.
 */
export async function listAllNodes(
  session: AuthSession,
  signal?: AbortSignal,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<NodeConnection> {
  const result = await paginate(
    (args) => listNodes(session, args, signal),
    pageSize,
  );
  return {
    edges: result.edges,
    totalCount: result.totalCount,
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

/**
 * Page through `nodeStatusList` until every status row is loaded. The
 * list-page join requires per-row Manager / ping data for every node
 * the page renders, so a truncated status fetch would leave tail rows
 * with `manager: null` / `ping: null` even though the manager is up.
 */
export async function listAllNodeStatuses(
  session: AuthSession,
  signal?: AbortSignal,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<NodeStatusConnection> {
  const result = await paginate(
    (args) => listNodeStatuses(session, args, signal),
    pageSize,
  );
  return {
    edges: result.edges,
    totalCount: result.totalCount,
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
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

/**
 * Combined `nodes:write + services:write` gate: insert touches both
 * node metadata and the agents/external-services membership in the
 * same payload. There is no canonical-node fetch here because the
 * node does not yet exist; the only scope signal is the submitted
 * `customerId`, which is checked directly against the caller's scope.
 */
export async function insertNode(
  session: AuthSession,
  args: InsertNodeArgs,
  signal?: AbortSignal,
): Promise<string> {
  await requireAllPermissions(session, [NODES_WRITE, SERVICES_WRITE]);
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

/**
 * Save a draft on an existing node.
 *
 * Tenant scope is verified against the **canonical** node fetched by
 * `id` from review-web, never against the caller-supplied `oldNode` /
 * `newDraft` payloads — a Tenant Administrator could otherwise call
 * with an out-of-scope `id` and an in-scope `customerId` in the
 * payload to slip a draft past the BFF gate. We additionally enforce
 * that the proposed draft does not move the node to a customer
 * outside the caller's scope, and reject a non-System-Administrator
 * caller who proposes a customerless target state (`profileDraft:
 * null`) — a customerless node is treated as System-Administrator-
 * only on read (see `enforceNodeScope`), so the write side must
 * symmetrically refuse to create one outside that role.
 *
 * Combined `nodes:write + services:write` gate: `updateNodeDraft`
 * touches both node metadata and per-service drafts in a single
 * mutation, so both scopes are required.
 */
export async function updateNodeDraft(
  session: AuthSession,
  id: string,
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
  signal?: AbortSignal,
): Promise<string> {
  await requireAllPermissions(session, [NODES_WRITE, SERVICES_WRITE]);
  const ctx = await buildDispatchContext(session);
  // Authoritative scope check: pin the decision on the canonical node
  // identified by `id`, not on the payload values that originated from
  // an untrusted client form.
  await assertCanonicalNodeInScope(ctx, id, signal);
  // Defense-in-depth: a caller in scope for the existing node must
  // not be able to rewrite its draft to point at a different
  // customer outside their scope, nor blank out the customer entirely.
  const newCustomer = newDraft.profileDraft?.customerId;
  if (newCustomer === undefined) {
    if (ctx.role !== SYSTEM_ADMINISTRATOR) {
      throw new NodePermissionError(
        "Proposed draft has no customer scope; only System Administrators can save customerless drafts.",
      );
    }
  } else {
    assertNodeInScope(ctx, Number(newCustomer));
  }
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

/**
 * Delete one or more nodes by id.
 *
 * Tenant scope is verified against the **canonical** node fetched by
 * each `id` from review-web before the delete mutation reaches the
 * wire. Delete is destructive and the BFF receives raw ids from the
 * client; without this preflight a Tenant Administrator scoped to
 * customer X could submit ids belonging to customer Y and review-web
 * would receive the delete (it might reject by its own scope filter,
 * but the BFF tenant-scope contract — "no out-of-scope mutation
 * reaches the wire" — would already be broken).
 *
 * System Administrators skip the preflight (no extra round trips for
 * the global-delete case) because `assertCanonicalNodeInScope` is a
 * no-op for them. Missing ids surface as `NodeNotFoundError` via the
 * shared not-found mapping; out-of-scope ids surface as
 * `NodePermissionError`.
 */
export async function removeNodes(
  session: AuthSession,
  ids: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  await requireAllPermissions(session, [NODES_DELETE]);
  const ctx = await buildDispatchContext(session);
  if (ctx.role !== SYSTEM_ADMINISTRATOR) {
    for (const id of ids) {
      await assertCanonicalNodeInScope(ctx, id, signal);
    }
  }
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
 *
 * Tenant scope is verified against the **canonical** node fetched by
 * `id` (not the submitted `node.profile?.customerId`) so a forged
 * payload cannot bypass the BFF gate. We additionally enforce that
 * the proposed apply does not move the node to a customer outside
 * the caller's scope, and reject a non-System-Administrator caller
 * who proposes a customerless target state (both `node.profile` and
 * `node.profileDraft` null) — a customerless node is treated as
 * System-Administrator-only on read (see `enforceNodeScope`), so the
 * apply path must symmetrically refuse to promote the node into one.
 *
 * Combined `nodes:write + services:write` gate: a node-level apply
 * promotes both the node-metadata draft and the per-service drafts
 * in a single mutation (review-web's `applyNode` contract), so both
 * scopes are required.
 */
export async function applyNode(
  session: AuthSession,
  id: string,
  node: NodeInput,
  signal?: AbortSignal,
): Promise<string> {
  await requireAllPermissions(session, [NODES_WRITE, SERVICES_WRITE]);
  const ctx = await buildDispatchContext(session);
  await assertCanonicalNodeInScope(ctx, id, signal);
  const profileCustomer = node.profile?.customerId;
  const draftCustomer = node.profileDraft?.customerId;
  if (profileCustomer === undefined && draftCustomer === undefined) {
    if (ctx.role !== SYSTEM_ADMINISTRATOR) {
      throw new NodePermissionError(
        "Apply target has no customer scope; only System Administrators can apply customerless nodes.",
      );
    }
  }
  if (profileCustomer !== undefined) {
    assertNodeInScope(ctx, Number(profileCustomer));
  }
  if (draftCustomer !== undefined) {
    assertNodeInScope(ctx, Number(draftCustomer));
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
  await requireAllPermissions(session, [NODES_WRITE]);
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
  await requireAllPermissions(session, [NODES_WRITE]);
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
  await requireAllPermissions(session, [SERVICES_READ]);
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
  await requireAllPermissions(session, [SERVICES_READ]);
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
  await requireAllPermissions(session, [SERVICES_WRITE]);
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
  await requireAllPermissions(session, [SERVICES_READ]);
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
  await requireAllPermissions(session, [SERVICES_READ]);
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
  await requireAllPermissions(session, [SERVICES_WRITE]);
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
