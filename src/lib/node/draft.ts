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
  AgentDraftInput,
  AgentInput,
  ExternalServiceInput,
  Node as ManagerNode,
  NodeDetailResult,
  NodeDraftInput,
  NodeInput,
  NodeProfileInput,
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

function profilesEqual(
  a: NodeProfileInput | null,
  b: NodeProfileInput | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.customerId === b.customerId &&
    a.description === b.description &&
    a.hostname === b.hostname
  );
}

/**
 * Rebase the user's intended draft on top of a freshly-read canonical
 * node. The returned draft is what should be sent to `updateNodeDraft`
 * on the replay attempt: every field the user actually edited is
 * preserved at the user's value; every field the user left alone takes
 * the latest server value, so a concurrent writer's edit on an
 * untouched field/service is **not** clobbered by replaying the
 * user's stale snapshot of it.
 *
 * Why this matters: `agents` and `externalServices` in `NodeDraftInput`
 * are replacement payloads — sending the user's whole list back
 * verbatim would overwrite a sibling service's draft that another
 * writer changed concurrently. We diff per-(kind, key) draft string
 * (the field a save-draft can change) to decide which entries to
 * forward at the user's value vs. swap in the fresh value.
 */
function rebaseDraftOnFresh(
  originalOld: NodeInput,
  originalNew: NodeDraftInput,
  freshOld: NodeInput,
): NodeDraftInput {
  const userOldName = originalOld.nameDraft ?? originalOld.name;
  const freshName = freshOld.nameDraft ?? freshOld.name;
  const userTouchedName = originalNew.nameDraft !== userOldName;
  const nameDraft = userTouchedName ? originalNew.nameDraft : freshName;

  const userOldProfile = originalOld.profileDraft ?? originalOld.profile;
  const freshProfile = freshOld.profileDraft ?? freshOld.profile;
  const userTouchedProfile = !profilesEqual(
    originalNew.profileDraft,
    userOldProfile,
  );
  const profileDraft = userTouchedProfile
    ? originalNew.profileDraft
    : freshProfile;

  let agents: AgentDraftInput[] | null = null;
  if (originalNew.agents !== null) {
    const oldDraftByKey = new Map<string, string | null>();
    for (const a of originalOld.agents) {
      oldDraftByKey.set(`${a.kind}::${a.key}`, a.draft ?? null);
    }
    const freshByKey = new Map<string, AgentInput>();
    for (const a of freshOld.agents) {
      freshByKey.set(`${a.kind}::${a.key}`, a);
    }
    agents = originalNew.agents.map((proposed) => {
      const id = `${proposed.kind}::${proposed.key}`;
      const userPriorDraft = oldDraftByKey.get(id) ?? null;
      const proposedDraft = proposed.draft ?? null;
      const userTouched = proposedDraft !== userPriorDraft;
      if (userTouched) return proposed;
      const fresh = freshByKey.get(id);
      if (fresh) {
        return {
          kind: proposed.kind,
          key: proposed.key,
          status: proposed.status,
          draft: fresh.draft ?? null,
        };
      }
      return proposed;
    });
  }

  let externalServices: ExternalServiceInput[] | null = null;
  if (originalNew.externalServices !== null) {
    const oldDraftByKey = new Map<string, string | null>();
    for (const e of originalOld.externalServices) {
      oldDraftByKey.set(`${e.kind}::${e.key}`, e.draft ?? null);
    }
    const freshByKey = new Map<string, ExternalServiceInput>();
    for (const e of freshOld.externalServices) {
      freshByKey.set(`${e.kind}::${e.key}`, e);
    }
    externalServices = originalNew.externalServices.map((proposed) => {
      const id = `${proposed.kind}::${proposed.key}`;
      const userPriorDraft = oldDraftByKey.get(id) ?? null;
      const proposedDraft = proposed.draft ?? null;
      const userTouched = proposedDraft !== userPriorDraft;
      if (userTouched) return proposed;
      const fresh = freshByKey.get(id);
      if (fresh) {
        return {
          kind: proposed.kind,
          key: proposed.key,
          status: proposed.status,
          draft: fresh.draft ?? null,
        };
      }
      return proposed;
    });
  }

  return { nameDraft, profileDraft, agents, externalServices };
}

/**
 * True when every field of `draft` already matches the corresponding
 * field of `freshOld` — i.e. the proposed save would write the same
 * values the server already has. The replay path uses this to short-
 * circuit a redundant mutation (see the idempotence note on
 * `saveDraft`): if a user retries `saveDraft` with the same payload
 * after a successful first call, the rebased draft will be a no-op
 * against the fresh state, and we return success without dispatching
 * the second mutation or emitting a duplicate audit row.
 */
function isNoOpAgainstFresh(
  freshOld: NodeInput,
  draft: NodeDraftInput,
): boolean {
  const freshName = freshOld.nameDraft ?? freshOld.name;
  if (draft.nameDraft !== freshName) return false;
  const freshProfile = freshOld.profileDraft ?? freshOld.profile;
  if (!profilesEqual(draft.profileDraft, freshProfile)) return false;
  return diffChangedServices(freshOld, draft).length === 0;
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
 * Idempotence: a caller that retries `saveDraft` with the same
 * `(id, old, new)` after a successful first call will stale-conflict
 * on the second attempt (because `old` no longer matches the server
 * state). The replay re-reads the canonical node, rebases the user's
 * intent on top of that fresh baseline, and — when the rebased draft
 * already matches the fresh state byte-for-byte — short-circuits
 * before dispatching the redundant mutation. Net effect: the redundant
 * retry writes nothing and emits zero additional audits.
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
  // and **rebase** the user's intended draft on top of that fresh
  // baseline (see `rebaseDraftOnFresh`) so a concurrent writer's edit
  // on a field/service the user did not touch is preserved rather than
  // clobbered by replaying the user's stale snapshot. The audit then
  // reflects the true diff between fresh-old and the rebased draft —
  // never the user's original payload.
  //
  // A second stale-conflict on the rebased dispatch is propagated as a
  // typed `StaleConflictError` so the UI can ask the user to re-edit.
  const ctx = await buildDispatchContext(session);
  const fresh = await fetchNodeForReplay(ctx, id, signal);
  const replayOld = nodeToInput(fresh);
  const rebased = rebaseDraftOnFresh(oldNode, newDraft, replayOld);

  // Idempotence short-circuit: when the rebased draft already matches
  // the fresh server state, the user's intent has been fulfilled by a
  // concurrent writer (typically: the same caller retrying after a
  // successful first save). Skip the redundant mutation entirely so
  // a retry writes once and audits once across the pair of calls.
  if (isNoOpAgainstFresh(replayOld, rebased)) {
    return id;
  }

  try {
    const result = await updateNodeDraft(
      session,
      id,
      replayOld,
      rebased,
      signal,
    );
    const changes = diffChangedServices(replayOld, rebased);
    await emitDraftSaveAudits(
      session,
      id,
      changes,
      resolveAuditCustomer(replayOld, rebased),
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
