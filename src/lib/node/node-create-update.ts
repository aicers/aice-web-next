import "server-only";

import { auditLog } from "@/lib/audit/logger";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";

import { saveDraft } from "./draft";
import { NodePermissionError } from "./errors";
import { type InsertNodeArgs, insertNode } from "./server-actions";
import { deriveServiceModeChanges } from "./services/agent-modes";
import type { NodeDraftInput, NodeInput } from "./types";

const NODES_WRITE = "nodes:write";
const SERVICES_WRITE = "services:write";

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
 * `service.set_mode` audit payload, one per agent service whose
 * Configure-Here / Manually selection differs between the persisted
 * before and after state. The selection is encoded on the wire by the
 * agent draft string (empty/null → Manually, non-empty →
 * Configure-Here), so it can be recovered server-side from the same
 * payload the manager already trusts via the CAS contract — no
 * client-supplied diff is involved.
 */
export interface ServiceModeChange {
  serviceKind: string;
  mode: "configure-here" | "configure-manually";
}

interface AuditCommonContext {
  ip?: string | null;
}

/**
 * Create a new node and emit the `node.create` audit (plus any
 * `service.set_mode` entries derived from the persisted agent state).
 * Audits fire only after the upstream `insertNode` mutation succeeds;
 * failures emit nothing. The `service.set_mode` rows are computed
 * server-side from `args.agents` against the registry default mode for
 * each both-mode kind — the request body never carries a
 * client-supplied mode diff that the BFF would have to trust.
 */
export async function createNodeWithAudit(
  session: AuthSession,
  args: InsertNodeArgs,
  context: AuditCommonContext = {},
  signal?: AbortSignal,
): Promise<string> {
  await assertWritePermissions(session);
  const nodeId = await insertNode(session, args, signal);

  await auditLog.record({
    actor: session.accountId,
    action: "node.create",
    target: "node",
    targetId: nodeId,
    details: {
      name: args.name,
      hostname: args.hostname,
      customerId: args.customerId,
    },
    ip: context.ip ?? undefined,
    sid: session.sessionId,
    customerId: Number(args.customerId),
  });

  const modeChanges = deriveServiceModeChanges(null, args.agents);
  await emitServiceSetModeAudits(
    session,
    nodeId,
    modeChanges,
    Number(args.customerId),
    context,
  );

  return nodeId;
}

/**
 * Edit an existing node by saving a new draft, then emit
 * `node.update` (only when node-metadata fields changed) and any
 * `service.set_mode` entries derived server-side from the persisted
 * before/after agent state. Per-service `service.draft_save` audits
 * remain owned by `saveDraft` itself (Phase Node-9). Audits fire only
 * after `updateNodeDraft` succeeds **and** the call actually persisted
 * a change — `saveDraft`'s replay path can short-circuit when the
 * rebased draft already matches fresh server state (e.g. an idempotent
 * retry after a successful first save, or a concurrent writer that
 * already applied the same change). In that case `persisted` is
 * `false` and we emit no derived audit rows; otherwise this layer
 * would record `node.update` / `service.set_mode` for a request that
 * wrote nothing.
 *
 * The before/after pair this layer audits comes from
 * `saveDraft`'s `effectiveOld` / `effectiveDraft` — i.e. the
 * `(old, new)` the manager actually accepted, equal to the caller's
 * inputs on the success path but equal to the freshly-fetched baseline
 * and the rebased draft on the replay path. Auditing the caller's
 * stale inputs would over-report changes that a concurrent writer
 * already applied (so the replay only persisted a subset) and could
 * scope rows under a stale customer.
 */
export async function updateNodeWithAudit(
  session: AuthSession,
  nodeId: string,
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
  context: AuditCommonContext = {},
  signal?: AbortSignal,
): Promise<string> {
  await assertWritePermissions(session);
  const { id, persisted, effectiveOld, effectiveDraft } = await saveDraft(
    session,
    nodeId,
    oldNode,
    newDraft,
    signal,
  );

  // No-op replay short-circuit: when `saveDraft` decided the rebased
  // draft already matches fresh server state, nothing was written, so
  // the contract — "audit rows fire only when the change is persisted"
  // — bars us from recording `node.update` / `service.set_mode`.
  if (!persisted) {
    return id;
  }

  const changedFields = diffMetadataFields(effectiveOld, effectiveDraft);
  if (changedFields.length > 0) {
    const customerId = resolveAuditCustomer(effectiveOld, effectiveDraft);
    await auditLog.record({
      actor: session.accountId,
      action: "node.update",
      target: "node",
      targetId: nodeId,
      details: { changedFields },
      ip: context.ip ?? undefined,
      sid: session.sessionId,
      customerId,
    });
  }

  const customerId = resolveAuditCustomer(effectiveOld, effectiveDraft);
  // `agents === null` on the effective draft means "no change to the
  // agents list" — a metadata-only Save can never imply a mode toggle,
  // so skip derivation entirely in that case rather than treat absence
  // as removal.
  if (effectiveDraft.agents !== null) {
    const modeChanges = deriveServiceModeChanges(
      effectiveOld.agents,
      effectiveDraft.agents,
    );
    await emitServiceSetModeAudits(
      session,
      nodeId,
      modeChanges,
      customerId,
      context,
    );
  }

  return id;
}

async function emitServiceSetModeAudits(
  session: AuthSession,
  nodeId: string,
  changes: readonly ServiceModeChange[],
  customerId: number | undefined,
  context: AuditCommonContext,
): Promise<void> {
  for (const change of changes) {
    await auditLog.record({
      actor: session.accountId,
      action: "service.set_mode",
      target: "service",
      targetId: `${nodeId}:${change.serviceKind}`,
      details: {
        serviceKind: change.serviceKind,
        mode: change.mode,
        nodeId,
      },
      ip: context.ip ?? undefined,
      sid: session.sessionId,
      customerId,
    });
  }
}

/**
 * Names of the metadata fields whose changes drive `node.update`.
 * Service drafts are explicitly excluded — they emit
 * `service.draft_save` (owned by Phase Node-9), not `node.update`.
 */
export function diffMetadataFields(
  oldNode: NodeInput,
  newDraft: NodeDraftInput,
): string[] {
  const changed: string[] = [];

  const oldName = oldNode.nameDraft ?? oldNode.name;
  if (newDraft.nameDraft !== oldName) changed.push("name");

  const oldProfile = oldNode.profileDraft ?? oldNode.profile;
  const newProfile = newDraft.profileDraft;

  if ((newProfile?.customerId ?? null) !== (oldProfile?.customerId ?? null)) {
    changed.push("customerId");
  }
  if ((newProfile?.description ?? null) !== (oldProfile?.description ?? null)) {
    changed.push("description");
  }
  if ((newProfile?.hostname ?? null) !== (oldProfile?.hostname ?? null)) {
    changed.push("hostname");
  }

  return changed;
}

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
