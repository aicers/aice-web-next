import "server-only";

import { gigantoClient, tivanClient } from "@/lib/graphql/external-client";

import type { DispatchContext } from "./dispatch-context";
import { withExternalErrorMapping } from "./error-mapping";
import { GIGANTO_CONFIG_QUERY, TIVAN_CONFIG_QUERY } from "./queries";
import type {
  AgentKind,
  ExternalServiceKind,
  GigantoConfig,
  GigantoConfigResult,
  Node,
  TivanConfig,
  TivanConfigResult,
} from "./types";

/**
 * Service-type read abstraction.
 *
 * Read helpers are routed per service kind, mirroring the type table
 * in `decisions/node-and-service-mgmt.md`:
 *
 *   - **agent** kinds (`UNSUPERVISED`, `SEMI_SUPERVISED`, `SENSOR`,
 *     `TIME_SERIES_GENERATOR`) → review-web. The `agents[]` entries
 *     on the Node payload (already returned by `getNode` /
 *     `listNodes`) carry both `config` (applied) and `draft` directly,
 *     so no additional dispatch is needed.
 *   - **external** kinds (`DATA_STORE`, `TI_CONTAINER`) → applied
 *     config is fetched from the service's own `config` query (Giganto
 *     or Tivan, never review-web). The draft is still stored on
 *     review-web and surfaces on the Node payload via
 *     `externalServices[].draft`.
 *   - **manager** kind → review-web. v1 review-web does not expose a
 *     per-node manager config or draft surface, so both reads return
 *     `null`. The dispatch entry is preserved so callers can iterate
 *     over all seven service kinds without a special case.
 *
 * Write operations are NOT exposed here. Bulk apply composes
 * node-scoped writes (the manager pair `applyNodeDraft` +
 * `applyAgentConfig`, plus the external `updateConfig` follow-ups)
 * directly. A `saveDraft` / `apply` helper keyed on `serviceKind`
 * would suggest a per-service apply capability that does not exist in
 * v1; the uniform per-service abstraction is deferred to a later
 * phase (tracked under #333). See the service-dispatch comment in
 * `decisions/node-and-service-mgmt.md` for the full rationale.
 *
 * The dispatch context is the first argument by convention and is
 * threaded directly to the underlying GraphQL client — these helpers
 * never re-derive tenant scope or call other server actions that
 * would. Callers must have already built `ctx` via
 * `buildDispatchContext` and verified the node is in scope before
 * invoking these helpers.
 */

/**
 * The full union of service kinds aice-web-next can dispatch on.
 * `MANAGER` is included so the type-dispatch table is exhaustive
 * across all seven services the v1 UI surfaces.
 */
export type ServiceKind = AgentKind | ExternalServiceKind | "MANAGER";

const AGENT_KINDS: ReadonlySet<AgentKind> = new Set([
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
  "SENSOR",
  "TIME_SERIES_GENERATOR",
]);

const EXTERNAL_KINDS: ReadonlySet<ExternalServiceKind> = new Set([
  "DATA_STORE",
  "TI_CONTAINER",
]);

export function isAgentKind(kind: ServiceKind): kind is AgentKind {
  return AGENT_KINDS.has(kind as AgentKind);
}

export function isExternalKind(kind: ServiceKind): kind is ExternalServiceKind {
  return EXTERNAL_KINDS.has(kind as ExternalServiceKind);
}

/**
 * Read the applied config for a single service on a node. The Node
 * payload (already fetched from review-web) is passed in so the
 * agent/manager paths do not duplicate a `getNode` call; only the
 * external path opens a fresh GraphQL connection (to Giganto or
 * Tivan), and it routes through `gigantoClient` / `tivanClient`
 * with the dispatch context — never through the manager server
 * actions, which would re-derive the tenant scope.
 *
 * The external path is gated on the node's actual service membership
 * (`node.externalServices[].kind`). Without that gate, asking for a
 * service the node does not host would still open the deployment-
 * global Giganto/Tivan endpoint and surface its config as if the node
 * had it. v1 deployments are single-Giganto / single-Tivan, so the
 * external endpoint URL is shared across all nodes — only the
 * per-node `externalServices[]` membership distinguishes which nodes
 * host which kinds.
 *
 * Returns `null` if the service entry is absent on this node, or
 * present but its applied config is empty (agent in 'directly
 * configured' mode, external never applied), or if the kind is
 * `MANAGER` (no per-node manager config in v1).
 */
export async function getApplied(
  ctx: DispatchContext,
  node: Node,
  kind: ServiceKind,
  signal?: AbortSignal,
): Promise<string | GigantoConfig | TivanConfig | null> {
  if (isAgentKind(kind)) {
    const agent = node.agents.find((a) => a.kind === kind);
    return agent?.config ?? null;
  }
  if (isExternalKind(kind)) {
    const service = node.externalServices.find((s) => s.kind === kind);
    if (!service) return null;
    // Reviewer Round 2 P2: external clients (Giganto / Tivan) keep
    // sending the materialized list. The omit-for-admin rule in
    // `jwtCustomerIdsFor` is review-only because external services'
    // Context-JWT validators were not audited under #405; broadening
    // the rule to them would silently change a JWT claim they may
    // rely on.
    const requestContext = {
      role: ctx.role,
      customerIds: ctx.customerIds,
    };
    if (kind === "DATA_STORE") {
      const data = await withExternalErrorMapping(
        "DATA_STORE",
        gigantoClient<GigantoConfigResult>(
          GIGANTO_CONFIG_QUERY,
          undefined,
          requestContext,
          signal,
        ),
      );
      return data.config;
    }
    const data = await withExternalErrorMapping(
      "TI_CONTAINER",
      tivanClient<TivanConfigResult>(
        TIVAN_CONFIG_QUERY,
        undefined,
        requestContext,
        signal,
      ),
    );
    return data.config;
  }
  // MANAGER: review-web does not expose a per-node manager config in
  // v1 (decisions/node-and-service-mgmt.md). Returning null keeps the
  // dispatch table exhaustive without inventing a phantom read path.
  return null;
}

/**
 * Read the draft config for a single service on a node. Drafts live
 * on review-web for both agent and external kinds, so this never
 * dispatches to Giganto or Tivan — the entire result is read off the
 * Node payload that the caller already has in hand. `MANAGER` has no
 * draft surface in v1 (no editing path) so it returns `null`.
 */
export function getDraft(
  ctx: DispatchContext,
  node: Node,
  kind: ServiceKind,
): string | null {
  void ctx; // Tenant scope is enforced by the caller before this runs.
  if (isAgentKind(kind)) {
    const agent = node.agents.find((a) => a.kind === kind);
    return agent?.draft ?? null;
  }
  if (isExternalKind(kind)) {
    const service = node.externalServices.find((s) => s.kind === kind);
    return service?.draft ?? null;
  }
  // MANAGER: see getApplied — no per-node manager draft in v1.
  return null;
}
