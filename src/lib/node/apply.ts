import "server-only";

/**
 * Real-backend `ApplyDispatcher` and `ManagerDraftReader` for the
 * ApplyAttempt lifecycle (Phase Node-9c, #361).
 *
 * The lifecycle module shipped by Phase Node-9a (#359) takes a
 * dispatcher + draft reader as required arguments and has no
 * production default — this file is the first place in the codebase
 * where a callable code path reaches the real GraphQL transport for a
 * bulk apply. The state-machine call order, atomic claim, post-claim
 * guarded writes, sequential advance, rollup table, fingerprint
 * recompute (5a–5d), stale-lock recovery, and TTL helpers are all
 * reused from #359 wholesale; only the dispatcher / reader bindings
 * differ.
 *
 * Production-safety boundary:
 *
 *   - `_internal_applyNodeViaManager` is the renamed `applyNode`
 *     wrapper relocated from `server-actions.ts`. It is no longer a
 *     `"use server"` action and is **not** intended to be reachable
 *     from the modal Apply button. The only sanctioned caller is
 *     `ProductionApplyDispatcher.manager()` below — it directly
 *     promotes a node's drafts to applied state without writing an
 *     `ApplyAttempt` row, which is the wrong semantics for the
 *     user-facing bulk-apply path. A non-modal caller that genuinely
 *     needs direct-promotion semantics (no preview, no
 *     `ApplyAttempt` row, no per-external follow-up) may import this
 *     helper, but every such call site MUST document the rationale.
 *
 *   - `ProductionApplyDispatcher.external()` reads the live
 *     `config` from the target service before each dispatch and
 *     forwards it as `old`, then sends the frozen `new` from the
 *     planned dispatch row (`apply_attempts.planned_dispatches`)
 *     unchanged. This is the `(old fresh, new frozen)` retry
 *     contract from the umbrella: every retry refetches `old`, but
 *     `new` is byte-identical to the first attempt's `new` even
 *     after the manager step has cleared the external service's
 *     draft slot.
 */

import type { AuthSession } from "@/lib/auth/jwt";
import { graphqlRequest } from "@/lib/graphql/client";
import { gigantoClient, tivanClient } from "@/lib/graphql/external-client";
import type {
  ManagerDraftReader,
  NodeDraftSnapshot,
} from "./apply-attempt-lifecycle";
import type {
  ApplyDispatcher,
  ExternalDispatchInput,
  ManagerDispatchInput,
} from "./apply-attempt-types";
import {
  assertNodeInScope,
  buildDispatchContext,
  type DispatchContext,
} from "./dispatch-context";
import {
  withExternalErrorMapping,
  withManagerErrorMapping,
  withNodeNotFoundMapping,
} from "./error-mapping";
import { NodeNotFoundError, NodePermissionError } from "./errors";
import {
  APPLY_NODE_MUTATION,
  GIGANTO_CONFIG_QUERY,
  GIGANTO_UPDATE_CONFIG_MUTATION,
  NODE_DETAIL_QUERY,
  TIVAN_CONFIG_QUERY,
  TIVAN_UPDATE_CONFIG_MUTATION,
} from "./queries";
import type {
  ApplyNodeResult,
  GigantoConfig,
  GigantoConfigResult,
  GigantoUpdateConfigResult,
  Node as ManagerNode,
  NodeDetailResult,
  NodeInput,
  TivanConfig,
  TivanConfigResult,
  TivanUpdateConfigResult,
} from "./types";

interface ApplyNodeVariables extends Record<string, unknown> {
  id: string;
  node: NodeInput;
}

interface UpdateConfigVariables extends Record<string, unknown> {
  old: string;
  new: string;
}

/**
 * Direct manager-side promotion of a node's drafts via the upstream
 * `applyNode` mutation. Renamed from the previous `applyNode` server
 * action (#308) because the user-facing bulk-apply path lands here
 * with #361 — leaving a `"use server"` `applyNode(...)` callable would
 * let a future contributor accidentally bind the modal Apply button
 * to a path that bypasses the `ApplyAttempt` lifecycle (no preview,
 * no fingerprint guard, no per-external follow-up).
 *
 * Only the production `ApplyDispatcher.manager()` below should call
 * this helper. See the deny-list entry in the static-analysis
 * acceptance test (`apply-attempts-public-surface.test.ts`).
 */
export async function _internal_applyNodeViaManager(
  session: AuthSession,
  id: string,
  node: NodeInput,
  signal?: AbortSignal,
): Promise<string> {
  const ctx = await buildDispatchContext(session);
  await assertCanonicalNodeInScope(ctx, id, signal);
  const profileCustomer = node.profile?.customerId;
  const draftCustomer = node.profileDraft?.customerId;
  if (profileCustomer === undefined && draftCustomer === undefined) {
    // Customerless nodes (manager-only nodes, cluster bootstrap, the
    // empty-customers install case) are only writable by callers
    // carrying `customers:access-all`. The decision MUST key off
    // `ctx.hasGlobalScope` — not the audit-only `ctx.role` string —
    // because a multi-role account whose first role is not
    // `"System Administrator"`, or a custom role granting
    // `customers:access-all`, must still pass this guard. See the
    // contract in `dispatch-context.ts`.
    if (!ctx.hasGlobalScope) {
      throw new NodePermissionError(
        "Apply target has no customer scope; only globally-scoped callers can apply customerless nodes.",
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
  if (!data.node) {
    throw new NodeNotFoundError(`Node ${id} was not found.`);
  }
  return data.node;
}

async function assertCanonicalNodeInScope(
  ctx: DispatchContext,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  // Globally-scoped callers (`customers:access-all`) bypass the
  // canonical-node preflight: the upstream `applyNode` mutation
  // already performs the authoritative scope check, and the preflight
  // would otherwise reject a customerless node before it reached the
  // upstream. Keyed off `hasGlobalScope` so a multi-role account or a
  // custom role with `customers:access-all` is treated correctly.
  if (ctx.hasGlobalScope) return;
  const node = await fetchCanonicalNode(ctx, id, signal);
  enforceNodeScope(ctx, node);
}

/**
 * Wrapper-level customer-scope recheck for an in-flight apply
 * attempt. The bulk-apply wrapper calls this on every confirm and
 * every retry — *before* invoking the lifecycle's `_internal_*` core
 * — so a caller whose customer scope changed since they built the
 * attempt cannot keep driving manager / external dispatches against
 * a node that is no longer in their scope.
 *
 * Why this is needed at the wrapper layer rather than the dispatcher:
 *
 *   - The manager dispatcher (`_internal_applyNodeViaManager`) does
 *     a canonical-node scope check, but external dispatches go
 *     straight from `runOneDispatch()` through to
 *     `dispatcher.external()`, which talks to the deployment-global
 *     Giganto / Tivan endpoints with no per-node scope re-derivation.
 *     A retry whose target is external would otherwise bypass the
 *     scope check entirely.
 *   - Re-using the canonical-node read here keeps the privileged-
 *     bypass logic for `customers:access-all` callers in one place
 *     (the `hasGlobalScope` short-circuit). For tenant-scoped callers
 *     this costs one canonical-node read per confirm/retry — the
 *     manager-step recompute path will read the node again inside
 *     5a, but the security boundary needs to land *before* any
 *     dispatch reaches the wire, so the duplicate read is the price
 *     of a safe boundary.
 *
 * Globally-scoped callers (`hasGlobalScope === true`) skip the
 * customer-scope enforcement step (they have no tenant boundary), but
 * the canonical-node read still runs as an existence check. Without
 * it, an external retry path — which goes straight from
 * `runOneDispatch()` to `dispatcher.external()` with no manager lookup
 * once the manager step has already succeeded — would happily drive
 * `updateConfig` against the deployment-global Giganto / Tivan
 * endpoints and emit `node.apply` for a node that has since been
 * deleted (round 7). For a deleted node the helper throws
 * `NodeNotFoundError` — the same surface a globally-scoped caller
 * would see on the create-attempt path — so the failure mode is
 * "node disappeared", not "permission denied".
 *
 * Tenant-scoped not-found remap (round 3): for a tenant-scoped caller,
 * review-web's scope filter resolves an out-of-scope node to the same
 * shape as a deleted node — either `{ node: null }` or a NOT_FOUND
 * GraphQL error — both of which `fetchCanonicalNode` surfaces as
 * `NodeNotFoundError`. The wrapper-level acceptance for confirm/retry
 * requires `NodePermissionError` for the scope-shrunk case, mirroring
 * the same remap that `apply-attempts.ts:readCanonicalNode` uses on
 * the create-attempt surface. We remap here only for tenant-scoped
 * callers — the manager dispatcher's pre-promotion guard
 * (`assertCanonicalNodeInScope`) keeps `NodeNotFoundError` for genuinely
 * missing canonical reads driven by step 5a, because the lifecycle's
 * post-claim path explicitly distinguishes "node deleted" from "out of
 * scope" via that error type. Globally-scoped callers see the original
 * `NodeNotFoundError` for a deleted node — the remap does not apply
 * because they have no scope-shrunk semantics to hide.
 */
export async function assertAttemptNodeInScope(
  ctx: DispatchContext,
  nodeId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (ctx.hasGlobalScope) {
    // Existence check only. A NodeNotFoundError here means the node
    // was deleted between attempt creation and this confirm/retry —
    // surface it unchanged so callers (and tests) can distinguish
    // "deleted" from "permission denied".
    await fetchCanonicalNode(ctx, nodeId, signal);
    return;
  }
  try {
    const node = await fetchCanonicalNode(ctx, nodeId, signal);
    enforceNodeScope(ctx, node);
  } catch (err) {
    if (err instanceof NodeNotFoundError) {
      throw new NodePermissionError(
        `Node ${nodeId} is not in the caller's customer scope.`,
      );
    }
    throw err;
  }
}

function enforceNodeScope(ctx: DispatchContext, node: ManagerNode): void {
  const customerId = node.profile?.customerId ?? node.profileDraft?.customerId;
  if (customerId === undefined) {
    if (ctx.hasGlobalScope) return;
    throw new NodePermissionError(
      "Node carries no customer scope; only globally-scoped callers can apply it.",
    );
  }
  assertNodeInScope(ctx, Number(customerId));
}

/**
 * Build the production `ManagerDraftReader`. Reads the canonical
 * Node payload from review-web through the same `graphqlRequest`
 * call site as `getNode`, then projects it to the
 * `NodeDraftSnapshot` shape the lifecycle module expects.
 *
 * Used by the post-claim manager dispatch path's step 5a (fresh
 * `node(id)` read for fingerprint recompute) and never by the
 * `createApplyAttempt` plan-build path (#359 wires that read
 * directly to `graphqlRequest`).
 */
export function buildProductionDraftReader(
  ctx: DispatchContext,
  signal?: AbortSignal,
): ManagerDraftReader {
  return {
    async readNodeDraft(nodeId: string): Promise<NodeDraftSnapshot> {
      const node = await fetchCanonicalNode(ctx, nodeId, signal);
      return projectNodeSnapshot(node);
    },
  };
}

function projectNodeSnapshot(node: ManagerNode): NodeDraftSnapshot {
  return {
    id: node.id,
    name: node.name,
    nameDraft: node.nameDraft,
    profile: node.profile
      ? {
          customerId: node.profile.customerId,
          description: node.profile.description,
          hostname: node.profile.hostname,
        }
      : null,
    profileDraft: node.profileDraft
      ? {
          customerId: node.profileDraft.customerId,
          description: node.profileDraft.description,
          hostname: node.profileDraft.hostname,
        }
      : null,
    agents: node.agents.map((a) => ({
      kind: a.kind,
      key: a.key,
      status: a.status,
      config: a.config,
      draft: a.draft,
    })),
    externalServices: node.externalServices.map((s) => ({
      kind: s.kind,
      key: s.key,
      status: s.status,
      draft: s.draft,
    })),
  };
}

/**
 * Production `ApplyDispatcher` factory.
 *
 *   - `manager()` invokes the upstream `applyNode(id, NodeInput)`
 *     mutation via `_internal_applyNodeViaManager`.
 *   - `external()` reads the live `config` from the target external
 *     service (Giganto for `DATA_STORE`, Tivan for `TI_CONTAINER`),
 *     forwards it verbatim as `old` to the upstream `updateConfig`
 *     mutation, and uses the frozen `new` payload from
 *     `apply_attempts.planned_dispatches` (passed through
 *     `input.newConfig`) verbatim. The `oldConfig` value the
 *     lifecycle threads through `input.oldConfig` is **not** used
 *     here — the umbrella's retry contract requires `old` to be
 *     fresh on every dispatch (including the first), so the
 *     dispatcher always re-fetches `config`. The frozen `new` is
 *     authoritative because by the time a retry runs, the manager
 *     step has already promoted / cleared the manager-side draft;
 *     re-reading it would surface a different value than the
 *     operator confirmed.
 */
export function buildProductionApplyDispatcher(
  session: AuthSession,
  ctx: DispatchContext,
  signal?: AbortSignal,
): ApplyDispatcher {
  return {
    async manager(input: ManagerDispatchInput): Promise<void> {
      const nodeInput = input.nodeInput as NodeInput;
      await _internal_applyNodeViaManager(
        session,
        input.nodeId,
        nodeInput,
        signal,
      );
    },
    async external(
      serviceKind: "DATA_STORE" | "TI_CONTAINER",
      input: ExternalDispatchInput,
    ): Promise<void> {
      if (serviceKind === "DATA_STORE") {
        const oldFresh = await readGigantoConfigAsString(ctx, signal);
        await dispatchGigantoUpdateConfig(
          ctx,
          oldFresh,
          input.newConfig,
          signal,
        );
        return;
      }
      const oldFresh = await readTivanConfigAsString(ctx, signal);
      await dispatchTivanUpdateConfig(ctx, oldFresh, input.newConfig, signal);
    },
  };
}

async function readGigantoConfigAsString(
  ctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<GigantoConfigResult>(
      GIGANTO_CONFIG_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return JSON.stringify(canonicalGigantoConfig(data.config));
}

async function readTivanConfigAsString(
  ctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const data = await withExternalErrorMapping(
    "TI_CONTAINER",
    tivanClient<TivanConfigResult>(
      TIVAN_CONFIG_QUERY,
      undefined,
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
  return JSON.stringify(canonicalTivanConfig(data.config));
}

async function dispatchGigantoUpdateConfig(
  ctx: DispatchContext,
  oldConfig: string,
  newConfig: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<GigantoUpdateConfigResult, UpdateConfigVariables>(
      GIGANTO_UPDATE_CONFIG_MUTATION,
      { old: oldConfig, new: newConfig },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
}

async function dispatchTivanUpdateConfig(
  ctx: DispatchContext,
  oldConfig: string,
  newConfig: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await withExternalErrorMapping(
    "TI_CONTAINER",
    tivanClient<TivanUpdateConfigResult, UpdateConfigVariables>(
      TIVAN_UPDATE_CONFIG_MUTATION,
      { old: oldConfig, new: newConfig },
      { role: ctx.role, customerIds: ctx.customerIds },
      signal,
    ),
  );
}

/**
 * Canonical-key-order serialisation of the live `config` payload so a
 * concurrent reorder of object keys by upstream graphql-request does
 * not spuriously reject the upstream `updateConfig` CAS check.
 */
function canonicalGigantoConfig(
  config: GigantoConfig,
): Record<string, unknown> {
  return {
    ackTransmission: config.ackTransmission,
    dataDir: config.dataDir,
    exportDir: config.exportDir,
    graphqlSrvAddr: config.graphqlSrvAddr,
    ingestSrvAddr: config.ingestSrvAddr,
    maxMbOfLevelBase: config.maxMbOfLevelBase,
    maxOpenFiles: config.maxOpenFiles,
    maxSubcompactions: config.maxSubcompactions,
    numOfThread: config.numOfThread,
    publishSrvAddr: config.publishSrvAddr,
    retention: config.retention,
  };
}

function canonicalTivanConfig(config: TivanConfig): Record<string, unknown> {
  return {
    excelData: config.excelData,
    graphqlSrvAddr: config.graphqlSrvAddr,
    originMitre: config.originMitre,
    translateMitre: config.translateMitre,
  };
}
