import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";

import { gigantoConfigToToml, tivanConfigToToml } from "./applied-config-toml";
import { ExternalServiceUnavailableError } from "./errors";
import type {
  ExternalConfigSnapshot,
  MutableExternalConfigSnapshot,
} from "./pending-state";
import { getGigantoConfig, getTivanConfig } from "./server-actions";
import type { ExternalServiceKind, Node as ManagerNode } from "./types";

/**
 * Server-side builder for the page-load `ExternalConfigSnapshot`
 * threaded into client components (#551). Each kind's external endpoint
 * is read once; the structured response is projected to the canonical
 * TOML form (`gigantoConfigToToml` / `tivanConfigToToml`) so the client
 * comparison happens against the same shape the dialog's deserialise
 * round-trips.
 *
 * A failed read records `"unavailable"` for that key and lets the page
 * continue rendering. The client surfaces it as the unknown / offline
 * state — distinct from both "pending" and "not pending" — and disables
 * Apply.
 *
 * `kinds` filters the set of endpoints to read. The detail page passes
 * the union of `node.externalServices[].kind` so we never touch
 * endpoints irrelevant to the current node; the list page passes the
 * union across every visible node so the cell-level pending dots stay
 * accurate without per-row fan-out.
 */
export async function buildExternalConfigSnapshot(
  session: AuthSession,
  kinds: ReadonlyArray<ExternalServiceKind>,
  signal?: AbortSignal,
): Promise<ExternalConfigSnapshot> {
  const wanted = new Set(kinds);
  const out: MutableExternalConfigSnapshot = {};
  const fetches: Promise<void>[] = [];
  if (wanted.has("DATA_STORE")) {
    fetches.push(
      getGigantoConfig(session, signal)
        .then((config) => {
          out.DATA_STORE = gigantoConfigToToml(config);
        })
        .catch((err) => {
          if (err instanceof ExternalServiceUnavailableError) {
            out.DATA_STORE = "unavailable";
            return;
          }
          throw err;
        }),
    );
  }
  if (wanted.has("TI_CONTAINER")) {
    fetches.push(
      getTivanConfig(session, signal)
        .then((config) => {
          out.TI_CONTAINER = tivanConfigToToml(config);
        })
        .catch((err) => {
          if (err instanceof ExternalServiceUnavailableError) {
            out.TI_CONTAINER = "unavailable";
            return;
          }
          throw err;
        }),
    );
  }
  if (fetches.length > 0) await Promise.all(fetches);
  return out;
}

/**
 * Collect the distinct external-service kinds the given node hosts.
 * Helper for callers that only want to fetch the kinds in scope.
 */
export function externalKindsOnNode(
  node: Pick<ManagerNode, "externalServices">,
): ExternalServiceKind[] {
  const seen = new Set<ExternalServiceKind>();
  for (const ext of node.externalServices) seen.add(ext.kind);
  return Array.from(seen);
}

/**
 * Collect the distinct external-service kinds across a set of nodes.
 * Used by the list page to bound the snapshot to kinds actually in
 * play across the rendered rows.
 */
export function externalKindsOnNodes(
  nodes: ReadonlyArray<Pick<ManagerNode, "externalServices">>,
): ExternalServiceKind[] {
  const seen = new Set<ExternalServiceKind>();
  for (const node of nodes) {
    for (const ext of node.externalServices) seen.add(ext.kind);
  }
  return Array.from(seen);
}
