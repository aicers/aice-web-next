import "server-only";

import { auditLog } from "@/lib/audit/logger";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { graphqlRequest } from "@/lib/graphql/client";

import { buildDispatchContext, type DispatchContext } from "./dispatch-context";
import {
  withManagerErrorMapping,
  withNodeNotFoundMapping,
} from "./error-mapping";
import { NodeNotFoundError, NodePermissionError } from "./errors";
import { NODE_DETAIL_QUERY } from "./queries";
import { updateNodeDraft } from "./server-actions";
import type {
  AgentInput,
  ExternalServiceInput,
  Node as ManagerNode,
  NodeDetailResult,
  NodeDraftInput,
  NodeInput,
} from "./types";

/**
 * Thrown when two consecutive `updateNodeDraft` calls return the
 * documented stale-conflict shape (CAS check failure on review-web's
 * `updateNodeDraft` resolver). The first stale-conflict triggers a
 * single replay against a freshly-read node; a second stale-conflict
 * propagates as this typed error so the UI can present a reconciliation
 * prompt — discard local edits, or re-apply on top of the latest state.
 *
 * Detection regex is documented in `decisions/node-conflict-patterns.md`.
 * When Phase Node-4 (#310) lands `src/lib/node/conflict-patterns.ts`
 * with the captured fixtures, this helper should migrate to that
 * authoritative module so version-bump regressions surface in one place.
 */
export class StaleConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StaleConflictError";
  }
}

const STALE_CONFLICT_REGEX =
  /(concurrent modification|node was modified|stale)\b/i;

interface GraphQLLikeError {
  message?: string;
}

function isStaleConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const direct =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
  if (STALE_CONFLICT_REGEX.test(direct)) return true;
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors || errors.length === 0) return false;
  return errors.some((e) =>
    typeof e?.message === "string"
      ? STALE_CONFLICT_REGEX.test(e.message)
      : false,
  );
}

const NODES_WRITE = "nodes:write";
const SERVICES_WRITE = "services:write";

/**
 * Boundary permission check for save-draft. Both `nodes:write` and
 * `services:write` are required because a save-draft mutation touches
 * node-metadata drafts and per-service drafts in the same payload.
 * Rejection happens **before** any GraphQL dispatch (including the
 * canonical-node preflight) so an unauthorized caller never reaches
 * the wire.
 */
async function assertWritePermissions(session: AuthSession): Promise<void> {
  for (const permission of [NODES_WRITE, SERVICES_WRITE]) {
    if (!(await hasPermission(session.roles, permission))) {
      throw new NodePermissionError(
        `Caller lacks the ${permission} permission.`,
      );
    }
  }
}

/**
 * Re-read the canonical node bypassing the read-permission gate. The
 * caller has already cleared the write gate above, and the replay path
 * needs to fetch the current node state regardless of whether the
 * caller also holds `nodes:read` / `services:read`. Tenant scope is
 * still enforced — `updateNodeDraft` re-runs the canonical scope check
 * on the replay dispatch.
 */
async function fetchNodeForReplay(
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

/**
 * Map the server-shaped `Node` (returned by review-web) onto the
 * `NodeInput` shape that `updateNodeDraft`'s CAS contract expects as
 * `old`. The conversion drops the per-agent / per-external-service
 * `node` foreign key (which the input types do not carry) and
 * preserves every other field verbatim.
 */
function nodeToInput(node: ManagerNode): NodeInput {
  return {
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
    agents: node.agents.map<AgentInput>((a) => ({
      kind: a.kind,
      key: a.key,
      status: a.status,
      config: a.config,
      draft: a.draft,
    })),
    externalServices: node.externalServices.map<ExternalServiceInput>((e) => ({
      kind: e.kind,
      key: e.key,
      status: e.status,
      draft: e.draft,
    })),
  };
}

interface ChangedService {
  kind: string;
  key: string;
}

/**
 * Compute the set of services whose draft string actually changed
 * between `old` and `new`.
 *
 * Identity is `(kind, key)` because review-web's schema allows multiple
 * services of the same kind on a node (the per-agent `key` distinguishes
 * them). The `service.draft_save` audit row uses `kind` as the
 * `serviceKind` field per `decisions/node-permissions.md`; multiple
 * keys of the same kind therefore emit one row each, all sharing the
 * same composite `targetId` shape but distinguishable in `details` by
 * the surrounding context.
 *
 * `newDraft.agents` / `newDraft.externalServices` of `null` means "no
 * change requested" — those services contribute zero changes regardless
 * of the old state. A non-null list replaces the slot, so a service
 * present in `old` but absent from the new list is treated as removed
 * (which has no draft to save and emits no audit either way).
 */
function diffChangedServices(
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
): ChangedService[] {
  const changes: ChangedService[] = [];

  if (newDraft.agents !== null) {
    const oldByKey = new Map<string, AgentInput>();
    for (const a of oldNode.agents) {
      oldByKey.set(`${a.kind}::${a.key}`, a);
    }
    for (const proposed of newDraft.agents) {
      const key = `${proposed.kind}::${proposed.key}`;
      const previous = oldByKey.get(key);
      const previousDraft = previous?.draft ?? null;
      const proposedDraft = proposed.draft ?? null;
      if (previousDraft !== proposedDraft) {
        changes.push({ kind: proposed.kind, key: proposed.key });
      }
    }
  }

  if (newDraft.externalServices !== null) {
    const oldByKey = new Map<string, ExternalServiceInput>();
    for (const e of oldNode.externalServices) {
      oldByKey.set(`${e.kind}::${e.key}`, e);
    }
    for (const proposed of newDraft.externalServices) {
      const key = `${proposed.kind}::${proposed.key}`;
      const previous = oldByKey.get(key);
      const previousDraft = previous?.draft ?? null;
      const proposedDraft = proposed.draft ?? null;
      if (previousDraft !== proposedDraft) {
        changes.push({ kind: proposed.kind, key: proposed.key });
      }
    }
  }

  return changes;
}

/**
 * Resolve the customer id to attach to the audit row. Prefer the
 * proposed draft's customer (the post-save state most relevant to the
 * audit reader), fall back to the existing applied customer, and
 * finally to the existing draft customer. Returns `undefined` for the
 * customerless-node case (System-Administrator-only) — the audit row
 * is still written with a `null` customer column.
 */
function resolveAuditCustomer(
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
): number | undefined {
  const proposed = newDraft.profileDraft?.customerId;
  if (proposed !== undefined) return Number(proposed);
  const applied = oldNode.profile?.customerId;
  if (applied !== undefined) return Number(applied);
  const draft = oldNode.profileDraft?.customerId;
  if (draft !== undefined) return Number(draft);
  return undefined;
}

async function emitDraftSaveAudits(
  session: AuthSession,
  nodeId: string,
  changes: ChangedService[],
  customerId: number | undefined,
): Promise<void> {
  for (const change of changes) {
    await auditLog.record({
      actor: session.accountId,
      action: "service.draft_save",
      target: "service",
      targetId: `${nodeId}:${change.kind}`,
      details: { serviceKind: change.kind, nodeId },
      sid: session.sessionId,
      customerId,
    });
  }
}

/**
 * Save a node draft through review-web's `updateNodeDraft(id, old, new)`
 * CAS contract, with single-shot stale-conflict replay and per-service
 * `service.draft_save` audit emission.
 *
 * Flow:
 *
 * 1. Reject the caller with `NodePermissionError` unless both
 *    `nodes:write` and `services:write` are granted — before any
 *    GraphQL dispatch.
 * 2. Call `updateNodeDraft` (which performs its own canonical-node
 *    scope check, customer-scope guard, and dispatches the mutation).
 * 3. If the call rejects with the documented stale-conflict shape
 *    (`/(concurrent modification|node was modified|stale)\b/i` — see
 *    `decisions/node-conflict-patterns.md`), re-read the current node
 *    from review-web, rebuild `old` from the fresh state, and replay
 *    the same caller-supplied `newDraft` once. A second stale-conflict
 *    propagates as `StaleConflictError` so the UI can present a
 *    reconciliation prompt; non-stale errors propagate unchanged.
 * 4. On success, emit one `service.draft_save` audit per service
 *    whose draft string actually changed against the `old` that was
 *    ultimately accepted by the manager. A save with only node-
 *    metadata changes emits zero audits; a stale-conflict that
 *    replays successfully emits the audits **once** (against the
 *    replay `old`, not the original).
 *
 * Idempotence: this function does not de-duplicate at the BFF — the
 * CAS contract on review-web is the durable idempotence boundary. A
 * caller that retries `saveDraft` with the same `(id, old, new)` after
 * a successful first call will stale-conflict on the second attempt
 * (because `old` no longer matches), the replay will re-read and
 * apply the user's intent on top of the now-current state, and the
 * audit emission will reflect the actual diff between the fresh `old`
 * and `new` (which is empty when the new state already matches the
 * draft — zero audits emitted on the redundant retry).
 */
export async function saveDraft(
  session: AuthSession,
  id: string,
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
  signal?: AbortSignal,
): Promise<string> {
  await assertWritePermissions(session);

  try {
    const result = await updateNodeDraft(
      session,
      id,
      oldNode,
      newDraft,
      signal,
    );
    const changes = diffChangedServices(oldNode, newDraft);
    await emitDraftSaveAudits(
      session,
      id,
      changes,
      resolveAuditCustomer(oldNode, newDraft),
    );
    return result;
  } catch (err) {
    if (!isStaleConflictError(err)) throw err;
  }

  // Single replay path. We rebuild `old` from a fresh canonical fetch
  // and re-issue the same `newDraft` — the user's intent did not
  // change, only the baseline against which the CAS check runs. A
  // second stale-conflict is propagated as a typed error so the UI
  // can ask the user to re-edit.
  const ctx = await buildDispatchContext(session);
  const fresh = await fetchNodeForReplay(ctx, id, signal);
  const replayOld = nodeToInput(fresh);

  try {
    const result = await updateNodeDraft(
      session,
      id,
      replayOld,
      newDraft,
      signal,
    );
    const changes = diffChangedServices(replayOld, newDraft);
    await emitDraftSaveAudits(
      session,
      id,
      changes,
      resolveAuditCustomer(replayOld, newDraft),
    );
    return result;
  } catch (err) {
    if (isStaleConflictError(err)) {
      throw new StaleConflictError(
        "The node was modified concurrently. The replay also conflicted; the caller must re-fetch and re-edit.",
        { cause: err },
      );
    }
    // Non-stale errors on the replay propagate unchanged.
    throw err;
  }
}
