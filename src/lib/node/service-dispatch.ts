import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";

import type { DispatchContext } from "./dispatch-context";
import { getGigantoConfig, getTivanConfig } from "./server-actions";
import type {
  AgentKind,
  ExternalServiceKind,
  GigantoConfig,
  Node,
  TivanConfig,
} from "./types";

/**
 * Service-type read abstraction.
 *
 * Read helpers are routed per service kind, mirroring the type table
 * in `decisions/node-and-service-mgmt.md`:
 *
 *   - **agent** kinds (`UNSUPERVISED`, `SEMI_SUPERVISED`, `SENSOR`,
 *     `TIME_SERIES_GENERATOR`) → read from review-web via the Node
 *     payload already returned by `getNode` / `listNodes`. The
 *     `agents[]` entries carry both `config` (applied) and `draft`
 *     directly, so no additional dispatch is needed.
 *   - **external** kinds (`DATA_STORE`, `TI_CONTAINER`) → applied
 *     config is fetched from the service's own `config` query (Giganto
 *     or Tivan, never review-web). The draft, however, is still
 *     stored on review-web and surfaces on the Node payload via
 *     `externalServices[].draft`.
 *   - **manager** kind has no per-service applied / draft surface in
 *     v1 — review-web does not expose it. Calls for `MANAGER` raise
 *     `Error("Not implemented in v1")` rather than silently returning
 *     null, so a UI mistake surfaces loudly during development.
 *
 * Write operations are NOT exposed here. Phase Node-9 composes
 * node-scoped writes (`applyNode` + the two `updateConfig` follow-ups)
 * into bulk apply directly. A `saveDraft` / `apply` helper keyed on
 * `serviceKind` would suggest a per-service apply capability that
 * does not exist in v1; that uniform per-service abstraction lands
 * with Phase Node-12 (#333). See the service-dispatch comment in
 * `decisions/node-and-service-mgmt.md` for the full rationale.
 *
 * The dispatch context is the first argument by convention — never
 * re-derive tenant scope here. Caller is expected to have already
 * built it via `buildDispatchContext` and verified the node is in
 * scope before calling these helpers.
 */

/**
 * The full union of service kinds aice-web-next can dispatch on.
 * `MANAGER` is included so the type-dispatch table is exhaustive
 * even though the read path for it is unimplemented in v1.
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
 * Read the applied config for a single service on a node. The
 * node payload (already fetched from review-web) is passed in so the
 * agent path does not duplicate a `getNode` call; only the external
 * path opens a fresh GraphQL connection (to Giganto or Tivan).
 *
 * Returns `null` if the service entry is present but its applied
 * config is empty (agent in 'directly configured' mode, or external
 * never applied). Throws for `MANAGER` because the v1 schema does
 * not expose it.
 */
export async function getApplied(
  ctx: DispatchContext,
  session: AuthSession,
  node: Node,
  kind: ServiceKind,
  signal?: AbortSignal,
): Promise<string | GigantoConfig | TivanConfig | null> {
  void ctx; // Tenant scope is enforced by the caller before this runs.
  if (isAgentKind(kind)) {
    const agent = node.agents.find((a) => a.kind === kind);
    return agent?.config ?? null;
  }
  if (isExternalKind(kind)) {
    if (kind === "DATA_STORE") return getGigantoConfig(session, signal);
    return getTivanConfig(session, signal);
  }
  throw new Error(
    "getApplied: MANAGER service kind has no applied-config surface in v1.",
  );
}

/**
 * Read the draft config for a single service on a node. Drafts live
 * on review-web for both agent and external kinds, so this never
 * dispatches to Giganto or Tivan — the entire result is read off the
 * Node payload that the caller already has in hand.
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
  throw new Error("getDraft: MANAGER service kind has no draft surface in v1.");
}
