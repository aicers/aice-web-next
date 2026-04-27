import "server-only";

/**
 * ApplyAttempt lifecycle / state machine (Phase Node-9a, #359).
 *
 * IMPORTANT — production-safety boundary:
 * This module DOES NOT carry the `"use server"` directive. The two
 * entry points it exports are named `_internal_confirmApplyAttempt`
 * and `_internal_retryDispatch` to make their internal-only intent
 * obvious. They take the `ApplyDispatcher` as a **required** argument
 * with no production default — there is no callable surface here that
 * a UI request could reach. #361 (Phase Node-9c) will export real
 * `"use server"` actions wrapping these internal entry points and
 * binding a production GraphQL dispatcher; #359 ships only the state
 * machine + a test-only mock dispatcher in unit/integration tests.
 *
 * State-machine summary (umbrella #314):
 *   1. SELECT row (identity / actor check, or NotFound).
 *   2. Read-only status check + step-2a expiry short-circuit.
 *      For retry: step-2b per-dispatch state check.
 *   3. Optional pre-claim fingerprint hint check (treated as a hint
 *      only — only step 5b is authoritative).
 *   4. Atomic claim UPDATE — sets `executing_lock`, `claim_started_at`,
 *      `status = 'executing'`, advances the target dispatch to
 *      `in_flight` (and resets its `lastError`). Predicate enforces
 *      `executing_lock IS NULL AND now() <= expires_at AND ...`.
 *      0-row branch resolves by re-reading the row's observable
 *      status (busy / terminal / stale / expired / NotFound).
 *   5. Post-claim guarded executor loop. For the manager dispatch the
 *      just-before-dispatch sequence (5a–5d) refreshes the manager-DB
 *      draft state, recomputes the fingerprint, and either dispatches
 *      (step 5d) or writes `status = 'stale'` and rejects. Every
 *      executor-side UPDATE is guarded by
 *      `WHERE attempt_id = $1 AND executing_lock = <correlation_id>`.
 *      0-row from a guarded UPDATE aborts the executor without retry
 *      (loser-write rejection — typically the recovery sweep cleared
 *      the lock).
 *   6. Sequential advance: on success commit the current dispatch and
 *      advance the next `queued` to `in_flight` in the same UPDATE.
 *      On failure stop and leave subsequent `queued` untouched
 *      (or, on cap / abandonment, cascade remaining `queued` to
 *      `failed_terminal`).
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuthSession } from "@/lib/auth/jwt";
import { withTransaction } from "@/lib/db/client";

import {
  readApplyAttempt,
  terminaliseExpiredAttempt,
} from "./apply-attempt-cleanup";
import {
  type ApplyAttemptRow,
  type ApplyDispatcher,
  type DispatchState,
  type ExternalPlannedDispatch,
  getAttemptRetentionMs,
  getDispatchMaxAttempts,
  type ManagerPlannedDispatch,
  type PlannedDispatch,
} from "./apply-attempt-types";
import {
  ApplyAttemptBusyError,
  ApplyAttemptNotFoundError,
  ApplyAttemptTerminalError,
  DispatchNotFoundError,
  DispatchNotRetryableError,
  StalePlanError,
} from "./errors";

/**
 * Read-only manager-DB reader the lifecycle module uses for step 5a.
 * Implementations refresh the node's draft state from the production
 * GraphQL read layer (#308); test-only mocks supply a plain in-memory
 * fake. This is NOT the dispatcher — it never sends mutations.
 */
export interface ManagerDraftReader {
  /**
   * Read the current draft state for the given node id. Returns the
   * full Node payload — the lifecycle module will project `nodeNow`'s
   * draft fields and recompute the fingerprint over them.
   */
  readNodeDraft(nodeId: string): Promise<NodeDraftSnapshot>;
}

/**
 * The subset of Node fields that contribute to the fingerprint and to
 * the rebuilt `NodeInput`. Matches the shape returned by the manager's
 * `node(id)` query — but pinned here as a structural type so this
 * module does not depend on the full Node graph.
 */
export interface NodeDraftSnapshot {
  id: string;
  name: string;
  nameDraft: string | null;
  profile: { customerId: string; description: string; hostname: string } | null;
  profileDraft: {
    customerId: string;
    description: string;
    hostname: string;
  } | null;
  agents: Array<{
    kind: string;
    key: string;
    status: string;
    config: string | null;
    draft: string | null;
  }>;
  externalServices: Array<{
    kind: string;
    key: string;
    status: string;
    draft: string | null;
  }>;
}

/**
 * Compute the canonical SHA-256 fingerprint of the manager-DB draft
 * state involved in an apply plan.
 *
 * Canonical key order: serialise object keys alphabetically and array
 * entries by `kind` (then `key`) so a manager-DB draft that is
 * functionally identical produces a byte-identical hash regardless of
 * column order or array ordering returned by the upstream.
 *
 * Returned as a 32-byte Buffer for storage in `bytea` and as a
 * lowercase-hex string (32 → 64 chars) on the public response. The
 * caller passes the hex form back unchanged on confirm so the post-
 * claim recompute (step 5b) can match it byte-for-byte.
 */
export function computeDraftFingerprint(node: NodeDraftSnapshot): {
  bytes: Buffer;
  hex: string;
} {
  const canonical = canonicaliseNode(node);
  const json = JSON.stringify(canonical);
  const hash = createHash("sha256").update(json, "utf8").digest();
  return { bytes: hash, hex: hash.toString("hex") };
}

function canonicaliseNode(node: NodeDraftSnapshot): unknown {
  const agents = [...node.agents]
    .sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key))
    .map(sortObjectKeys);
  const externalServices = [...node.externalServices]
    .sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key))
    .map(sortObjectKeys);
  return {
    agents,
    externalServices,
    id: node.id,
    name: node.name,
    nameDraft: node.nameDraft,
    profile: node.profile ? sortObjectKeys(node.profile) : null,
    profileDraft: node.profileDraft ? sortObjectKeys(node.profileDraft) : null,
  };
}

function sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out as T;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build a `NodeInput`-shaped payload from the freshly-read manager-DB
 * draft state (step 5d). Promotes drafts to applied: every draft
 * field becomes the new applied field, drafts cleared.
 *
 * Typed as `unknown` on the dispatcher boundary so this module does
 * not have to import the full NodeInput graph; the production
 * dispatcher (#361) casts back to the canonical `NodeInput`.
 */
export function buildNodeInputFromDraft(node: NodeDraftSnapshot): unknown {
  return {
    name: node.nameDraft ?? node.name,
    nameDraft: null,
    profile: node.profileDraft ?? node.profile,
    profileDraft: null,
    agents: node.agents.map((a) => ({
      kind: a.kind,
      key: a.key,
      status: a.status,
      config: a.draft ?? a.config,
      draft: null,
    })),
    externalServices: node.externalServices.map((s) => ({
      kind: s.kind,
      key: s.key,
      status: s.status,
      draft: null,
    })),
  };
}

// ── Internal entry points ────────────────────────────────────────

export interface ConfirmApplyAttemptArgs {
  session: AuthSession;
  attemptId: string;
  /**
   * Optional pre-claim fingerprint hint. Treated as advisory only —
   * the umbrella explicitly lets drift settle between pre-claim and
   * post-claim recompute, so a mismatch here does NOT short-circuit.
   * Only step 5b's recompute is authoritative.
   */
  expectedDraftFingerprint?: string;
  dispatcher: ApplyDispatcher;
  draftReader: ManagerDraftReader;
}

export interface RetryDispatchArgs {
  session: AuthSession;
  attemptId: string;
  dispatchId: string;
  dispatcher: ApplyDispatcher;
  draftReader: ManagerDraftReader;
}

/**
 * Confirm an apply attempt.
 *
 * Internal-only: takes the dispatcher as a required argument, exported
 * under a `_internal_*` name from a non-`"use server"` module so no UI
 * request can reach this code path. #361 wraps it in a real
 * `confirmApplyAttempt` server action bound to the production
 * dispatcher.
 */
export async function _internal_confirmApplyAttempt(
  args: ConfirmApplyAttemptArgs,
): Promise<ApplyAttemptRow> {
  const { session, attemptId, dispatcher, draftReader } = args;

  const initialRow = await readApplyAttempt(attemptId);
  if (!initialRow) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }
  if (initialRow.createdBy !== session.accountId) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }

  // Step 2a: expiry short-circuit. Run BEFORE classification so an
  // expired pending row doesn't transit through the busy/terminal
  // check.
  if (
    (initialRow.status === "pending" ||
      initialRow.status === "failed_retryable") &&
    initialRow.expiresAt.getTime() < Date.now() &&
    initialRow.executingLock === null
  ) {
    await terminaliseExpiredAttempt(undefined, initialRow);
    throw new StalePlanError(`Apply attempt ${attemptId} has expired.`);
  }

  // Step 2: read-only status check. Recovery from `failed_retryable`
  // is explicit via `_internal_retryDispatch(dispatchId)`; a plain
  // confirm against a soft-failed row returns the persisted state
  // (idempotent), it does NOT auto-resume execution.
  switch (initialRow.status) {
    case "pending":
      // Eligible to claim — fall through to step 3.
      break;
    case "executing":
      throw new ApplyAttemptBusyError(
        `Apply attempt ${attemptId} is currently executing.`,
      );
    case "succeeded":
    case "failed_retryable":
      // Idempotent — return the persisted row unchanged. Resuming a
      // soft-failed attempt is the retry entrypoint's job.
      return initialRow;
    case "failed_terminal":
      throw new ApplyAttemptTerminalError(
        `Apply attempt ${attemptId} is failed_terminal.`,
      );
    case "stale":
    case "expired":
      throw new StalePlanError(
        `Apply attempt ${attemptId} is ${initialRow.status}.`,
      );
    default: {
      const exhaustive: never = initialRow.status;
      throw new Error(`Unhandled status: ${String(exhaustive)}`);
    }
  }

  // Step 3: optional pre-claim fingerprint hint. Compares the caller-
  // supplied hint against the persisted fingerprint without re-reading
  // the manager DB — a cheap drift signal. Mismatch is non-fatal per
  // the umbrella (drift may settle between pre-claim and post-claim
  // recompute), so we only log; only step 5b is authoritative.
  if (args.expectedDraftFingerprint !== undefined) {
    const persistedHex = initialRow.draftFingerprint.toString("hex");
    if (persistedHex !== args.expectedDraftFingerprint.toLowerCase()) {
      console.warn(
        `[apply-attempt] confirm pre-claim fingerprint hint mismatch for ${attemptId} (advisory only).`,
      );
    }
  }

  // Step 4: atomic claim.
  const correlationId = randomUUID();
  const claim = await tryClaim(attemptId, correlationId, "confirm", null);
  if (!claim) {
    return await resolveLostClaim(attemptId);
  }

  // Step 5/6: post-claim executor loop under our correlation_id.
  return await runExecutor(claim, correlationId, dispatcher, draftReader);
}

/**
 * Retry a single failed dispatch within an existing apply attempt.
 *
 * Internal-only — same boundary contract as
 * `_internal_confirmApplyAttempt`.
 */
export async function _internal_retryDispatch(
  args: RetryDispatchArgs,
): Promise<ApplyAttemptRow> {
  const { session, attemptId, dispatchId, dispatcher, draftReader } = args;

  const initialRow = await readApplyAttempt(attemptId);
  if (!initialRow) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }
  if (initialRow.createdBy !== session.accountId) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }

  // Step 2a: expiry short-circuit.
  if (
    (initialRow.status === "pending" ||
      initialRow.status === "failed_retryable") &&
    initialRow.expiresAt.getTime() < Date.now() &&
    initialRow.executingLock === null
  ) {
    await terminaliseExpiredAttempt(undefined, initialRow);
    throw new StalePlanError(`Apply attempt ${attemptId} has expired.`);
  }

  // Step 2: row-level status check.
  switch (initialRow.status) {
    case "failed_retryable":
      break;
    case "pending":
      throw new DispatchNotRetryableError(
        `Apply attempt ${attemptId} is in 'pending'; nothing to retry.`,
      );
    case "executing":
      throw new ApplyAttemptBusyError(
        `Apply attempt ${attemptId} is currently executing.`,
      );
    case "succeeded":
      return initialRow;
    case "failed_terminal":
      throw new ApplyAttemptTerminalError(
        `Apply attempt ${attemptId} is failed_terminal.`,
      );
    case "stale":
    case "expired":
      throw new StalePlanError(
        `Apply attempt ${attemptId} is ${initialRow.status}.`,
      );
    default: {
      const exhaustive: never = initialRow.status;
      throw new Error(`Unhandled status: ${String(exhaustive)}`);
    }
  }

  // Step 2b: per-dispatch state check.
  const target = initialRow.plannedDispatches.find(
    (d) => d.dispatchId === dispatchId,
  );
  if (!target) {
    throw new DispatchNotFoundError(
      `Dispatch ${dispatchId} not found on attempt ${attemptId}.`,
    );
  }
  if (target.state !== "failed_retryable") {
    throw new DispatchNotRetryableError(
      `Dispatch ${dispatchId} is in state '${target.state}'; only 'failed_retryable' may be retried.`,
    );
  }
  if (target.attemptCount >= getDispatchMaxAttempts()) {
    throw new ApplyAttemptTerminalError(
      `Dispatch ${dispatchId} has reached APPLY_DISPATCH_MAX_ATTEMPTS.`,
    );
  }

  // Step 4: atomic claim.
  const correlationId = randomUUID();
  const claim = await tryClaim(attemptId, correlationId, "retry", dispatchId);
  if (!claim) {
    return await resolveLostClaim(attemptId);
  }
  return await runExecutor(claim, correlationId, dispatcher, draftReader);
}

// ── State-machine internals ──────────────────────────────────────

/**
 * Atomic claim. Reads the row for sanity, builds the new
 * `planned_dispatches` JSONB, and runs an UPDATE whose WHERE clause
 * re-checks every predicate at the SQL level — so a concurrent claim
 * that races between our SELECT and UPDATE is rejected by SQL rather
 * than by app-code state.
 *
 * Predicates (all enforced in the UPDATE WHERE, not just the read):
 *   - executing_lock IS NULL
 *   - now() <= expires_at
 *   - confirm: status = 'pending'
 *   - retry:   status = 'failed_retryable'
 *              AND a JSON-path predicate that the target dispatch is
 *              still `failed_retryable` at SQL evaluation time. This
 *              closes the gap between step 2b's app-level read and the
 *              actual claim — if a competing call flipped the target
 *              dispatch's state in between, SQL rejects the claim and
 *              the 0-row branch resolves by observed row status.
 *
 * Returns the row as-claimed, or `null` if the claim failed.
 */
async function tryClaim(
  attemptId: string,
  correlationId: string,
  mode: "confirm" | "retry",
  retryDispatchId: string | null,
): Promise<ApplyAttemptRow | null> {
  return withTransaction(async (client) => {
    const current = await readApplyAttempt(attemptId, client);
    if (!current) return null;
    if (current.executingLock !== null) return null;
    if (current.expiresAt.getTime() < Date.now()) return null;
    if (mode === "confirm" && current.status !== "pending") return null;
    if (mode === "retry" && current.status !== "failed_retryable") return null;
    if (mode === "retry") {
      const target = current.plannedDispatches.find(
        (d) => d.dispatchId === retryDispatchId,
      );
      if (!target || target.state !== "failed_retryable") return null;
    }

    const newDispatches = advanceForClaim(
      current.plannedDispatches,
      mode,
      retryDispatchId,
    );

    if (mode === "confirm") {
      const result = await client.query(
        `
        UPDATE apply_attempts
        SET status = 'executing',
            executing_lock = $1,
            claim_started_at = NOW(),
            planned_dispatches = $2::jsonb
        WHERE attempt_id = $3
          AND executing_lock IS NULL
          AND status = 'pending'
          AND NOW() <= expires_at
        RETURNING attempt_id
        `,
        [correlationId, JSON.stringify(newDispatches), attemptId],
      );
      if (result.rowCount !== 1) return null;
    } else {
      // Retry: the JSON-path predicate `$[*] ? (@.dispatchId == $id &&
      // @.state == "failed_retryable")` ensures another concurrent call
      // that already promoted this dispatch out of `failed_retryable`
      // (e.g. a winning retry whose executor flipped it to `in_flight`
      // / `succeeded`) cannot have its claim shadowed by ours.
      const result = await client.query(
        `
        UPDATE apply_attempts
        SET status = 'executing',
            executing_lock = $1,
            claim_started_at = NOW(),
            planned_dispatches = $2::jsonb
        WHERE attempt_id = $3
          AND executing_lock IS NULL
          AND status = 'failed_retryable'
          AND NOW() <= expires_at
          AND jsonb_path_exists(
                planned_dispatches,
                '$[*] ? (@.dispatchId == $id && @.state == "failed_retryable")',
                jsonb_build_object('id', $4::text)
              )
        RETURNING attempt_id
        `,
        [
          correlationId,
          JSON.stringify(newDispatches),
          attemptId,
          retryDispatchId,
        ],
      );
      if (result.rowCount !== 1) return null;
    }
    return await readApplyAttempt(attemptId, client);
  });
}

function advanceForClaim(
  dispatches: PlannedDispatch[],
  mode: "confirm" | "retry",
  retryDispatchId: string | null,
): PlannedDispatch[] {
  if (mode === "retry") {
    return dispatches.map((d) => {
      if (d.dispatchId !== retryDispatchId) return d;
      return {
        ...d,
        state: "in_flight" as DispatchState,
        attemptCount: d.attemptCount + 1,
        lastError: null,
      };
    });
  }
  // Confirm only operates on `pending` rows where every dispatch is
  // `queued` — pick the first and promote it.
  let advanced = false;
  return dispatches.map((d) => {
    if (advanced) return d;
    if (d.state === "queued") {
      advanced = true;
      return {
        ...d,
        state: "in_flight" as DispatchState,
        attemptCount: d.attemptCount + 1,
        lastError: null,
      };
    }
    return d;
  });
}

/**
 * 0-row claim resolution: read the row's observed state and translate
 * to the umbrella's response taxonomy.
 */
async function resolveLostClaim(attemptId: string): Promise<ApplyAttemptRow> {
  const current = await readApplyAttempt(attemptId);
  if (!current) {
    throw new ApplyAttemptNotFoundError(
      `Apply attempt ${attemptId} was not found.`,
    );
  }

  // Step 4 0-row gap branch: executing_lock IS NULL && now() > expires_at.
  // Same-call terminalisation per umbrella.
  if (
    current.executingLock === null &&
    current.expiresAt.getTime() < Date.now() &&
    (current.status === "pending" || current.status === "failed_retryable")
  ) {
    await terminaliseExpiredAttempt(undefined, current);
    throw new StalePlanError(
      `Apply attempt ${attemptId} expired before claim.`,
    );
  }

  switch (current.status) {
    case "executing":
      throw new ApplyAttemptBusyError(
        `Apply attempt ${attemptId} is currently executing.`,
      );
    case "succeeded":
      return current;
    case "failed_retryable":
      // Winner failed before our re-SELECT; return the persisted state.
      return current;
    case "failed_terminal":
      throw new ApplyAttemptTerminalError(
        `Apply attempt ${attemptId} is failed_terminal.`,
      );
    case "stale":
    case "expired":
      throw new StalePlanError(
        `Apply attempt ${attemptId} is ${current.status}.`,
      );
    case "pending":
      // Pending with executing_lock null means the row was reverted
      // by recovery between our claim attempt and re-SELECT. Treat
      // as a transient busy.
      throw new ApplyAttemptBusyError(
        `Apply attempt ${attemptId} could not be claimed.`,
      );
    default: {
      const exhaustive: never = current.status;
      throw new Error(`Unhandled status: ${String(exhaustive)}`);
    }
  }
}

/**
 * Post-claim executor loop. Drives the `in_flight` dispatch (the one
 * we just promoted) and every subsequent `queued` dispatch under the
 * same `executing_lock`.
 */
async function runExecutor(
  claimedRow: ApplyAttemptRow,
  correlationId: string,
  dispatcher: ApplyDispatcher,
  draftReader: ManagerDraftReader,
): Promise<ApplyAttemptRow> {
  let row = claimedRow;
  // Loop guard — the worst case is one iteration per dispatch.
  const maxIterations = row.plannedDispatches.length + 2;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const inFlightIdx = row.plannedDispatches.findIndex(
      (d) => d.state === "in_flight",
    );
    if (inFlightIdx === -1) {
      // No in-flight dispatch — every dispatch is finalised. Commit
      // row → succeeded under our correlation_id.
      return await finaliseRow(row, correlationId, "succeeded");
    }
    const dispatch = row.plannedDispatches[inFlightIdx];

    let dispatchSucceeded = false;
    let dispatchError: Error | null = null;
    try {
      await runOneDispatch(row, dispatch, dispatcher, draftReader);
      dispatchSucceeded = true;
    } catch (err) {
      if (err instanceof StalePlanError) {
        await writeStaleAndClear(row, correlationId);
        throw err;
      }
      dispatchError = err instanceof Error ? err : new Error(String(err));
    }

    if (dispatchSucceeded) {
      const next = await commitDispatchSuccessAndAdvance(
        row,
        correlationId,
        inFlightIdx,
      );
      if (!next) {
        throw new ApplyAttemptBusyError(
          `Executor for attempt ${row.attemptId} lost its claim.`,
        );
      }
      row = next.row;
      if (next.completed) return row;
      continue;
    }

    const reachedCap = dispatch.attemptCount >= getDispatchMaxAttempts();
    const newState: DispatchState = reachedCap
      ? "failed_terminal"
      : "failed_retryable";
    const updated = await commitDispatchFailure(
      row,
      correlationId,
      inFlightIdx,
      newState,
      dispatchError?.message ?? "Unknown dispatch error",
    );
    if (!updated) {
      throw new ApplyAttemptBusyError(
        `Executor for attempt ${row.attemptId} lost its claim.`,
      );
    }
    return updated;
  }
  throw new Error("Executor loop exceeded its iteration cap.");
}

/**
 * Run a single dispatch through the dispatcher interface. For the
 * manager dispatch, run the just-before-dispatch sequence (5a–5d).
 */
async function runOneDispatch(
  row: ApplyAttemptRow,
  dispatch: PlannedDispatch,
  dispatcher: ApplyDispatcher,
  draftReader: ManagerDraftReader,
): Promise<void> {
  if (dispatch.kind === "MANAGER") {
    // 5a: read manager node fresh.
    const nodeNow = await draftReader.readNodeDraft(row.nodeId);
    // 5b: recompute fingerprint.
    const recomputed = computeDraftFingerprint(nodeNow);
    if (!recomputed.bytes.equals(row.draftFingerprint)) {
      // 5c: signal — caller writes status='stale' upstream.
      throw new StalePlanError(
        `Draft fingerprint drifted for attempt ${row.attemptId}.`,
      );
    }
    // 5d: dispatch.
    const nodeInput = buildNodeInputFromDraft(nodeNow);
    await dispatcher.manager({
      attemptId: row.attemptId,
      nodeId: row.nodeId,
      nodeInput,
    });
    return;
  }
  const ext = dispatch as ExternalPlannedDispatch;
  await dispatcher.external(ext.kind, {
    attemptId: row.attemptId,
    dispatchId: ext.dispatchId,
    oldConfig: ext.old ?? "",
    newConfig: ext.new,
  });
}

/**
 * Guarded UPDATE: write status='stale', clear executing_lock and
 * claim_started_at, rewrite expires_at to retention horizon. Skips
 * if our correlation_id no longer holds the row.
 */
async function writeStaleAndClear(
  row: ApplyAttemptRow,
  correlationId: string,
): Promise<void> {
  const retentionMs = getAttemptRetentionMs();
  await withTransaction(async (client) => {
    await client.query(
      `
      UPDATE apply_attempts
      SET status = 'stale',
          executing_lock = NULL,
          claim_started_at = NULL,
          expires_at = NOW() + ($2 || ' milliseconds')::interval
      WHERE attempt_id = $1
        AND executing_lock = $3
      `,
      [row.attemptId, String(retentionMs), correlationId],
    );
  });
}

/**
 * Guarded UPDATE: commit the current dispatch as succeeded, promote
 * the next queued dispatch (if any) to in_flight, or finalise the row
 * to succeeded.
 */
async function commitDispatchSuccessAndAdvance(
  row: ApplyAttemptRow,
  correlationId: string,
  inFlightIdx: number,
): Promise<{ row: ApplyAttemptRow; completed: boolean } | null> {
  const newDispatches = row.plannedDispatches.map((d, i) => {
    if (i === inFlightIdx) {
      return { ...d, state: "succeeded" as DispatchState, lastError: null };
    }
    return d;
  });
  let nextIdx = -1;
  for (let i = 0; i < newDispatches.length; i += 1) {
    if (newDispatches[i].state === "queued") {
      nextIdx = i;
      break;
    }
  }
  let completed = false;
  if (nextIdx !== -1) {
    newDispatches[nextIdx] = {
      ...newDispatches[nextIdx],
      state: "in_flight" as DispatchState,
      attemptCount: newDispatches[nextIdx].attemptCount + 1,
      lastError: null,
    };
  } else {
    completed = true;
  }

  return await withTransaction(async (client) => {
    if (completed) {
      const retentionMs = getAttemptRetentionMs();
      const result = await client.query(
        `
        UPDATE apply_attempts
        SET status = 'succeeded',
            executing_lock = NULL,
            claim_started_at = NULL,
            expires_at = NOW() + ($2 || ' milliseconds')::interval,
            planned_dispatches = $3::jsonb
        WHERE attempt_id = $1
          AND executing_lock = $4
        RETURNING attempt_id
        `,
        [
          row.attemptId,
          String(retentionMs),
          JSON.stringify(newDispatches),
          correlationId,
        ],
      );
      if (result.rowCount !== 1) return null;
      const refreshed = await readApplyAttempt(row.attemptId, client);
      if (!refreshed) return null;
      return { row: refreshed, completed: true };
    }
    const result = await client.query(
      `
      UPDATE apply_attempts
      SET planned_dispatches = $2::jsonb
      WHERE attempt_id = $1
        AND executing_lock = $3
      RETURNING attempt_id
      `,
      [row.attemptId, JSON.stringify(newDispatches), correlationId],
    );
    if (result.rowCount !== 1) return null;
    const refreshed = await readApplyAttempt(row.attemptId, client);
    if (!refreshed) return null;
    return { row: refreshed, completed: false };
  });
}

/**
 * Guarded UPDATE: commit the current dispatch as failed
 * (`failed_retryable` or `failed_terminal`). On `failed_retryable`
 * the row goes to `failed_retryable` and `expires_at` is preserved
 * (umbrella: original deadline survives a soft fail). On
 * `failed_terminal` cap, every remaining `queued` is cascaded to
 * `failed_terminal` with the same lastError, the row goes to
 * `failed_terminal`, and `expires_at` is rewritten to retention.
 */
async function commitDispatchFailure(
  row: ApplyAttemptRow,
  correlationId: string,
  inFlightIdx: number,
  newDispatchState: DispatchState,
  errorMessage: string,
): Promise<ApplyAttemptRow | null> {
  const isCap = newDispatchState === "failed_terminal";
  const newDispatches = row.plannedDispatches.map((d, i) => {
    if (i === inFlightIdx) {
      return { ...d, state: newDispatchState, lastError: errorMessage };
    }
    if (isCap && d.state === "queued") {
      return {
        ...d,
        state: "failed_terminal" as DispatchState,
        lastError: errorMessage,
      };
    }
    return d;
  });

  return await withTransaction(async (client) => {
    if (isCap) {
      const retentionMs = getAttemptRetentionMs();
      const result = await client.query(
        `
        UPDATE apply_attempts
        SET status = 'failed_terminal',
            executing_lock = NULL,
            claim_started_at = NULL,
            expires_at = NOW() + ($2 || ' milliseconds')::interval,
            planned_dispatches = $3::jsonb
        WHERE attempt_id = $1
          AND executing_lock = $4
        RETURNING attempt_id
        `,
        [
          row.attemptId,
          String(retentionMs),
          JSON.stringify(newDispatches),
          correlationId,
        ],
      );
      if (result.rowCount !== 1) return null;
    } else {
      const result = await client.query(
        `
        UPDATE apply_attempts
        SET status = 'failed_retryable',
            executing_lock = NULL,
            claim_started_at = NULL,
            planned_dispatches = $2::jsonb
        WHERE attempt_id = $1
          AND executing_lock = $3
        RETURNING attempt_id
        `,
        [row.attemptId, JSON.stringify(newDispatches), correlationId],
      );
      if (result.rowCount !== 1) return null;
    }
    return await readApplyAttempt(row.attemptId, client);
  });
}

/**
 * Finalise a row to a terminal state with no outstanding dispatch
 * (e.g. an empty plan). Guarded by correlation_id.
 */
async function finaliseRow(
  row: ApplyAttemptRow,
  correlationId: string,
  status: "succeeded" | "failed_terminal",
): Promise<ApplyAttemptRow> {
  const retentionMs = getAttemptRetentionMs();
  return await withTransaction(async (client) => {
    const result = await client.query(
      `
      UPDATE apply_attempts
      SET status = $2,
          executing_lock = NULL,
          claim_started_at = NULL,
          expires_at = NOW() + ($3 || ' milliseconds')::interval
      WHERE attempt_id = $1
        AND executing_lock = $4
      RETURNING attempt_id
      `,
      [row.attemptId, status, String(retentionMs), correlationId],
    );
    if (result.rowCount !== 1) {
      throw new ApplyAttemptBusyError(
        `Executor for attempt ${row.attemptId} lost its claim.`,
      );
    }
    const refreshed = await readApplyAttempt(row.attemptId, client);
    if (!refreshed) {
      throw new ApplyAttemptNotFoundError(
        `Apply attempt ${row.attemptId} disappeared during finalisation.`,
      );
    }
    return refreshed;
  });
}

// ── Public re-exports for callers ────────────────────────────────

export type {
  ApplyAttemptRow,
  ApplyDispatcher,
  DispatchState,
  ExternalPlannedDispatch,
  ManagerPlannedDispatch,
  PlannedDispatch,
};
