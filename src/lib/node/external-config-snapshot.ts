import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";

import { gigantoConfigToToml, tivanConfigToToml } from "./applied-config-toml";
import type { DispatchContext } from "./dispatch-context";
import { ExternalServiceUnavailableError } from "./errors";
import type {
  ExternalConfigSnapshot,
  MutableExternalConfigSnapshot,
} from "./pending-state";
import {
  getGigantoConfig,
  getTivanConfig,
  readGigantoConfigWithContext,
  readTivanConfigWithContext,
} from "./server-actions";
import type { ExternalServiceKind, Node as ManagerNode } from "./types";

type GigantoReader = (signal?: AbortSignal) => Promise<unknown>;
type TivanReader = (signal?: AbortSignal) => Promise<unknown>;

async function buildSnapshotWithReaders(
  kinds: ReadonlyArray<ExternalServiceKind>,
  readGiganto: GigantoReader,
  readTivan: TivanReader,
  signal: AbortSignal | undefined,
): Promise<ExternalConfigSnapshot> {
  const wanted = new Set(kinds);
  const out: MutableExternalConfigSnapshot = {};
  const fetches: Promise<void>[] = [];
  if (wanted.has("DATA_STORE")) {
    fetches.push(
      readGiganto(signal)
        .then((config) => {
          out.DATA_STORE = gigantoConfigToToml(
            config as Parameters<typeof gigantoConfigToToml>[0],
          );
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
      readTivan(signal)
        .then((config) => {
          out.TI_CONTAINER = tivanConfigToToml(
            config as Parameters<typeof tivanConfigToToml>[0],
          );
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
 *
 * Permission boundary: routes the read through `getGigantoConfig` /
 * `getTivanConfig`, which gate on `services:read`. This is the
 * page-load UI artifact path — the caller already holds `services:read`
 * (list/detail pages combine `nodes:read + services:read`). The
 * request-time plan-build read inside `createApplyAttempt` uses
 * {@link buildExternalConfigSnapshotForApply} instead so it stays
 * inside the documented bulk-apply gate
 * (`nodes:write + services:write`) without silently widening it.
 */
export async function buildExternalConfigSnapshot(
  session: AuthSession,
  kinds: ReadonlyArray<ExternalServiceKind>,
  signal?: AbortSignal,
): Promise<ExternalConfigSnapshot> {
  return buildSnapshotWithReaders(
    kinds,
    (sig) => getGigantoConfig(session, sig),
    (sig) => getTivanConfig(session, sig),
    signal,
  );
}

/**
 * Variant for `createApplyAttempt`'s request-time plan-build read.
 * Takes an already-built `DispatchContext` and uses the
 * `readGigantoConfigWithContext` / `readTivanConfigWithContext`
 * internal readers, which skip the `services:read` permission gate.
 *
 * Why a separate entry point: `createApplyAttempt`'s documented gate
 * is `nodes:write + services:write` (`decisions/node-permissions.md`),
 * so routing the plan-build read through the public, read-gated
 * helpers would silently widen the gate to also require
 * `services:read` and reject a write-only custom role that
 * legitimately holds the bulk-apply scopes. The caller still pays the
 * full authorization cost: `createApplyAttempt` enforces
 * `nodes:write + services:write` and `buildDispatchContext` enforces
 * the tenant-scope boundary before reaching this builder.
 */
export async function buildExternalConfigSnapshotForApply(
  ctx: DispatchContext,
  kinds: ReadonlyArray<ExternalServiceKind>,
  signal?: AbortSignal,
): Promise<ExternalConfigSnapshot> {
  return buildSnapshotWithReaders(
    kinds,
    (sig) => readGigantoConfigWithContext(ctx, sig),
    (sig) => readTivanConfigWithContext(ctx, sig),
    signal,
  );
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
