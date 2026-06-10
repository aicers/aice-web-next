"use server";

/**
 * Public server-action surface for the bulk-apply executor (Phase
 * Node-9c, #361).
 *
 * Exports exactly two `"use server"` actions:
 *
 *   - `confirmApplyAttempt({ attemptId, expectedDraftFingerprint? })`
 *   - `retryDispatch({ attemptId, dispatchId })`
 *
 * Each action:
 *
 *   1. Resolves the session from the request cookie. A forged
 *      `AuthSession` argument over the server-action wire would
 *      otherwise widen permissions or scope, so we never trust a
 *      caller-supplied session blob.
 *   2. Re-checks the combined `nodes:write + services:write` gate
 *      and rebuilds the dispatch context (which materialises tenant
 *      scope and rejects callers with no resolvable customer scope),
 *      then re-derives the *node-specific* customer scope from the
 *      manager DB and asserts the attempt's node is still in the
 *      caller's scope. All three checks happen before any GraphQL
 *      dispatch reaches the wire, so a caller whose permissions or
 *      tenant scope changed after they created the attempt — or
 *      whose retry target is an external service that would
 *      otherwise bypass the per-node guard inside
 *      `_internal_applyNodeDraftViaManager` — cannot drive a manager /
 *      external dispatch on the back of a stale row.
 *   3. Runs the `_internal_*` core from #359 with the production
 *      `ApplyDispatcher` and `ManagerDraftReader` from #361. The
 *      state-machine call order, atomic claim, post-claim guarded
 *      writes, sequential advance, rollup table, fingerprint
 *      recompute (5a–5d), stale-lock recovery, and TTL helpers are
 *      reused wholesale from #359; only the dispatcher / reader
 *      bindings change.
 *   4. On the call that drives the row from non-`succeeded` to
 *      `succeeded`, emits a single `node.apply` audit row with
 *      `targetId = "${nodeId}"` and
 *      `details = { appliedServices: [...] }`. The "exactly once
 *      per attempt that reaches succeeded" rule is enforced by a
 *      two-step persisted guard:
 *
 *        - `claimNodeApplyAuditSlot` flips
 *          `apply_attempts.succeeded_audit_emitted_at` NULL → NOW()
 *          via an atomic, guarded UPDATE; only the caller whose
 *          UPDATE returns a row may emit the audit. Idempotent
 *          re-confirms of an already-`succeeded` row, and concurrent
 *          wrappers racing on the same `attemptId` after the
 *          lifecycle has flipped the row, are both serialised by
 *          this single SQL check.
 *        - On audit-DB-write success, `markNodeApplyAuditCompleted`
 *          flips `succeeded_audit_completed_at` NULL → NOW(), making
 *          emission durable.
 *        - On audit-DB-write failure inside the wrapper (a
 *          non-duplicate error), `releaseNodeApplyAuditSlot` flips
 *          `emitted_at` back to NULL (guarded by `completed_at IS
 *          NULL`) so the user-driven retry path can re-claim the
 *          slot. Note that the cleanup sweep recovers a released
 *          slot through its OTHER candidate branch — the round-6
 *          "slot-never-claimed" path that matches `emitted_at IS
 *          NULL AND succeeded_at older than staleMs` — so a
 *          released slot is no longer invisible to recovery (it
 *          re-enters via the slot-never-claimed predicate after
 *          the staleness window elapses). On a recovery-time
 *          failure the sweep deliberately leaves the slot CLAIMED
 *          so the next sweep re-picks the same row through the
 *          slot-claimed predicate.
 *
 * `service.apply` is **not** emitted in v1 — that audit is reserved
 * for Phase Node-12 (#333).
 */

import { auditLog } from "@/lib/audit/logger";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import {
  assertAttemptNodeInScope,
  buildProductionApplyDispatcher,
  buildProductionDraftReader,
} from "./apply";
import {
  claimNodeApplyAuditSlot,
  markNodeApplyAuditCompleted,
  readApplyAttempt,
  releaseNodeApplyAuditSlot,
} from "./apply-attempt-cleanup";
import {
  _internal_confirmApplyAttempt,
  _internal_retryDispatch,
} from "./apply-attempt-lifecycle";
import type {
  ApplyAttemptClientRow,
  ApplyAttemptRow,
  ApplyAttemptStatus,
} from "./apply-attempt-types";
import { buildDispatchContext, type DispatchContext } from "./dispatch-context";
import { ApplyAttemptNotFoundError, NodePermissionError } from "./errors";

const NODES_WRITE = "nodes:write";
const SERVICES_WRITE = "services:write";

async function requireWritePermissions(session: AuthSession): Promise<void> {
  for (const permission of [NODES_WRITE, SERVICES_WRITE]) {
    if (!(await hasPermission(session.roles, permission))) {
      throw new NodePermissionError(
        `Caller lacks the ${permission} permission.`,
      );
    }
  }
}

async function resolveSession(): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) {
    throw new NodePermissionError(
      "Authenticated session required to drive an apply attempt.",
    );
  }
  return session;
}

/**
 * Wrapper-level node-scope recheck. Runs on every confirm and every
 * retry — *before* the lifecycle is invoked — so the security
 * boundary lands ahead of any manager / external dispatch.
 *
 * The check has three steps:
 *
 *   1. Read the persisted attempt row. A missing row, or a row owned
 *      by a different actor, is rejected as `ApplyAttemptNotFoundError`
 *      (the BFF does not leak whether the row exists for a foreign
 *      actor — same surface the lifecycle's step-1 check uses).
 *   2. If the row is in a status that can still reach a dispatcher
 *      (confirm: `pending`; retry: `failed_retryable`), re-read the
 *      canonical node from the manager DB. For tenant-scoped callers,
 *      the node's customer scope is compared against the caller's
 *      *current* `DispatchContext` and a node no longer in scope is
 *      rejected as `NodePermissionError`. For globally-scoped callers
 *      (`customers:access-all`) the same read is performed but only
 *      as an **existence check** (round 7) — there is no tenant
 *      boundary to enforce, but a deleted-node retry would otherwise
 *      jump straight to `dispatcher.external()` (the deployment-
 *      global Giganto / Tivan endpoints) and emit `node.apply` for a
 *      node that no longer exists. The manager-side scope guard
 *      inside `_internal_applyNodeDraftViaManager` only fires on manager
 *      dispatches and only checks scope, never existence — so this
 *      wrapper-level read is the security boundary that closes the
 *      deleted-node-on-external-retry gap.
 *
 *      For non-dispatchable statuses the lifecycle's step-2 returns
 *      the persisted row idempotently (`succeeded`) or rejects
 *      (`failed_terminal` / `stale` / `expired` / `executing`)
 *      without dispatching anything (round 8). Gating those branches
 *      on a canonical-node read would (a) make idempotent confirm
 *      of an already-`succeeded` row throw `NodeNotFoundError` once
 *      the node is later deleted, and (b) prevent a follow-up
 *      confirm/retry from finishing a still-pending `node.apply`
 *      emission against a row whose node was deleted between the
 *      success commit and audit completion. The wrapper-level check
 *      should only gate calls that can still reach a dispatcher.
 *   3. Returns the read attempt row so the caller can keep using it
 *      without a second `readApplyAttempt`.
 */
async function rebuildAndAssertNodeScope(
  session: AuthSession,
  ctx: DispatchContext,
  attemptId: string,
  dispatchableStatus: ApplyAttemptStatus,
  signal: AbortSignal | undefined,
): Promise<ApplyAttemptRow> {
  const attempt = await readApplyAttempt(attemptId);
  if (!attempt || attempt.createdBy !== session.accountId) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }
  if (attempt.status === dispatchableStatus) {
    await assertAttemptNodeInScope(ctx, attempt.nodeId, signal);
  }
  return attempt;
}

/**
 * Confirm an apply attempt, dispatching the manager pair
 * (`applyNodeDraft` then `applyAgentConfig`) followed by any external
 * `updateConfig` calls required by pending drafts. The state-machine
 * claims an `executing_lock`, runs the just-before-dispatch sequence
 * (5a–5d) for the manager step, and advances each external dispatch
 * under the same lock. On success the row is committed to `succeeded`
 * and a single `node.apply` audit row is emitted; on a transient
 * external failure the row is left in `failed_retryable` so the caller
 * can drive `retryDispatch` from the same `attemptId`.
 */
export async function confirmApplyAttempt(
  args: { attemptId: string; expectedDraftFingerprint?: string },
  signal?: AbortSignal,
): Promise<ApplyAttemptClientRow> {
  const session = await resolveSession();
  await requireWritePermissions(session);
  const ctx = await buildDispatchContext(session);

  // Node-specific customer-scope recheck BEFORE any dispatch reaches
  // the wire. Without this, a caller whose customer scope shrank
  // since they built the attempt could keep driving manager / external
  // dispatches against a node that is no longer in their scope (the
  // dispatcher.external() path has no per-node scope guard of its
  // own — it talks to the deployment-global Giganto / Tivan endpoints).
  // Only enforced when the row is `pending` — the only confirm-side
  // status that can still advance to dispatch (round 8). For
  // already-`succeeded` (idempotent return + audit-recovery finish)
  // and other terminal statuses the lifecycle does not reach the
  // dispatcher, so the canonical-node read is unnecessary and would
  // wrongly turn an idempotent confirm into `NodeNotFoundError` once
  // the node is later deleted.
  await rebuildAndAssertNodeScope(
    session,
    ctx,
    args.attemptId,
    "pending",
    signal,
  );

  const dispatcher = buildProductionApplyDispatcher(session, ctx, signal);
  const draftReader = buildProductionDraftReader(ctx, signal);

  const result = await _internal_confirmApplyAttempt({
    session,
    attemptId: args.attemptId,
    expectedDraftFingerprint: args.expectedDraftFingerprint,
    dispatcher,
    draftReader,
  });

  await maybeEmitNodeApplyAudit(session, result);
  return toClientApplyAttemptRow(result);
}

/**
 * Retry a single failed dispatch within an existing apply attempt.
 * For a manager retry the just-before-dispatch sequence (5a–5d) is
 * re-run, so a drift since the original confirm rejects with
 * `StalePlanError`; for an external retry the recompute is
 * deliberately skipped (the manager step has already promoted /
 * cleared the draft and the frozen `new` from
 * `apply_attempts.planned_dispatches` is authoritative).
 *
 * `node.apply` is emitted on the call that drives the row from
 * non-`succeeded` to `succeeded`; an attempt that reaches
 * `succeeded` via `confirmApplyAttempt` + one or more
 * `retryDispatch` calls emits the audit exactly once, on the call
 * that flips the row.
 */
export async function retryDispatch(
  args: { attemptId: string; dispatchId: string },
  signal?: AbortSignal,
): Promise<ApplyAttemptClientRow> {
  const session = await resolveSession();
  await requireWritePermissions(session);
  const ctx = await buildDispatchContext(session);

  // Same scope recheck as `confirmApplyAttempt`. Critical for retry
  // because an external retry path bypasses the manager-side scope
  // guard entirely — see the comment on `rebuildAndAssertNodeScope`.
  // Only enforced when the row is `failed_retryable` — the only
  // retry-side status that can still advance to dispatch (round 8).
  // For already-`succeeded` (idempotent return + audit-recovery
  // finish) and other terminal statuses the lifecycle short-circuits
  // before the dispatcher, so the canonical-node read is unnecessary
  // and would wrongly reject a follow-up retry that exists solely to
  // finish a pending `node.apply` audit emission.
  await rebuildAndAssertNodeScope(
    session,
    ctx,
    args.attemptId,
    "failed_retryable",
    signal,
  );

  const dispatcher = buildProductionApplyDispatcher(session, ctx, signal);
  const draftReader = buildProductionDraftReader(ctx, signal);

  const result = await _internal_retryDispatch({
    session,
    attemptId: args.attemptId,
    dispatchId: args.dispatchId,
    dispatcher,
    draftReader,
  });

  await maybeEmitNodeApplyAudit(session, result);
  return toClientApplyAttemptRow(result);
}

function toClientApplyAttemptRow(row: ApplyAttemptRow): ApplyAttemptClientRow {
  return {
    attemptId: row.attemptId,
    nodeId: row.nodeId,
    draftFingerprint: row.draftFingerprint.toString("hex"),
    plannedDispatches: row.plannedDispatches,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    executingLock: row.executingLock,
    claimStartedAt: row.claimStartedAt?.toISOString() ?? null,
    status: row.status,
    customerId: row.customerId,
  };
}

async function maybeEmitNodeApplyAudit(
  session: AuthSession,
  result: ApplyAttemptRow,
): Promise<void> {
  if (result.status !== "succeeded") return;
  // Two-layer "exactly once" guard for the umbrella's
  // "exactly once per attempt that reaches succeeded" contract:
  //
  //   Layer A (schema, round 3): `audit_logs` carries a partial unique
  //     index on `(correlation_id) WHERE action = 'node.apply' AND
  //     correlation_id IS NOT NULL`
  //     (`audit_logs_node_apply_correlation_unique` in the audit
  //     schema). Both this wrapper and
  //     `recoverPendingNodeApplyAudits` pass the
  //     attempt UUID as `correlationId`, so a duplicate emission — from
  //     any source, in any order — is rejected by the database with a
  //     `unique_violation` (PG error code 23505). This is the
  //     authoritative "no duplicates" guarantee; the slot machinery is
  //     a coordination mechanism on top of it.
  //
  //   Layer B (slot, round 1+2): `succeeded_audit_emitted_at` /
  //     `succeeded_audit_completed_at` serialise concurrent wrappers
  //     and steer the recovery sweep so the common case avoids a
  //     duplicate INSERT entirely:
  //
  //       1. `claimNodeApplyAuditSlot` flips `emitted_at` NULL → NOW()
  //          atomically. Concurrent racers and idempotent re-confirms
  //          observe `rowCount = 0` and skip.
  //       2. The winning claimant writes the audit row.
  //       3. On success, `markNodeApplyAuditCompleted` flips
  //          `completed_at` NULL → NOW(), making emission durable so
  //          the recovery sweep skips the row.
  //       4. On synchronous audit-DB failure that is NOT a duplicate
  //          (the row never landed), `releaseNodeApplyAuditSlot` clears
  //          `emitted_at` so a follow-up confirm/retry can re-attempt.
  //          On a `unique_violation` (the row DID land, e.g. the
  //          recovery sweep got there first), we leave the slot
  //          claimed and mark it completed — the audit is already
  //          durable in the audit DB and a release would let yet
  //          another caller try to re-emit and get rejected again.
  const claimed = await claimNodeApplyAuditSlot(result.attemptId);
  if (!claimed) return;
  const appliedServices = result.plannedDispatches
    .filter(
      (d) =>
        d.kind !== "MANAGER_DB" &&
        d.kind !== "MANAGER_NOTIFY" &&
        d.state === "succeeded",
    )
    .map((d) => d.kind);
  try {
    await auditLog.record({
      actor: session.accountId,
      action: "node.apply",
      target: "node",
      targetId: result.nodeId,
      details: { appliedServices },
      sid: session.sessionId,
      // Pulled from `apply_attempts.customer_id`, snapshotted at attempt
      // creation. NULL is permitted and intentional for nodes that
      // carry no `customerId` (only globally-scoped callers reach those).
      ...(result.customerId !== null && { customerId: result.customerId }),
      // Stable per-attempt key. Used by the partial unique index on
      // `audit_logs` (Layer A above) to make a second insert for the
      // same attempt physically impossible.
      correlationId: result.attemptId,
    });
  } catch (err) {
    if (isAuditDuplicateError(err)) {
      // The audit row is already in the audit DB (recovery sweep, a
      // concurrent slot-released retry, or a partially-failed prior
      // call that succeeded the INSERT before crashing). The schema
      // guarantee held — there is nothing to release. Mark completed
      // and treat this call as a successful no-op for the caller.
      await markNodeApplyAuditCompleted(result.attemptId).catch(() => {});
      return;
    }
    // Genuine audit-DB failure (connection refused, syntax error, etc.)
    // — the row did NOT land. Release the slot so a user-driven
    // follow-up confirm/retry can re-claim. As of round 6 the cleanup
    // sweep's recovery is also a fallback here: its candidate SELECT
    // now matches `emitted_at IS NULL` rows whose `succeeded_at`
    // (≈ `expires_at - retentionMs`) is older than the staleness
    // window, so a released slot re-enters automatic recovery once
    // that window elapses (in practice the operator-driven retry
    // closes the gap first). Best-effort release: a release that
    // itself throws is swallowed because the original error is
    // strictly more useful.
    await releaseNodeApplyAuditSlot(result.attemptId).catch(() => {});
    throw err;
  }
  // Audit insert succeeded; flip the completion marker. If THIS step
  // fails (audit landed, marker write threw), do NOT release the slot
  // — the duplicate-violation branch above will recover the next
  // confirm/retry, and the cleanup sweep will eventually pick the row
  // up via the `unique_violation` → mark-completed path. Releasing
  // here would let a follow-up call try to emit again, which the
  // schema would correctly reject as a duplicate, leaving the row
  // stuck claimed-but-not-completed for longer.
  try {
    await markNodeApplyAuditCompleted(result.attemptId);
  } catch {
    // Swallow: the audit is already durable, and the recovery sweep
    // will mark `completed_at` next pass via the duplicate path.
  }
}

/**
 * Detect a Postgres `unique_violation` (SQLSTATE 23505) bubbling up
 * from the audit DB INSERT. The audit logger does not wrap or rebrand
 * pg errors, so checking the `code` property on the thrown error is
 * the supported contract. Defensive against non-pg errors (e.g. a test
 * mock throwing a plain `Error`) — anything without the right code is
 * treated as a non-duplicate.
 */
function isAuditDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
