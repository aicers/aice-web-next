/**
 * Shared ApplyAttempt types (Phase Node-9a, #359).
 *
 * These types are NOT marked `"use server"` so they may be imported
 * from the cleanup helper, the lifecycle entry points, and the
 * `createApplyAttempt` server action without forcing every consumer
 * into a server-action call site.
 *
 * The lifecycle / state-machine surface is in
 * `apply-attempt-lifecycle.ts`; the cleanup surface is in
 * `apply-attempt-cleanup.ts`. The `createApplyAttempt` server action
 * is in `apply-attempts.ts` and is the ONLY `"use server"` export
 * shipped by #359.
 */

export type ApplyAttemptStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "stale"
  | "expired";

export type DispatchState =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal";

/**
 * The two dispatch shapes that compose a plan: a single manager
 * dispatch (re-derived from the manager-DB draft state at the moment
 * of dispatch — no frozen `new`), followed by zero or more external
 * dispatches each carrying a frozen `new` payload (the durability
 * contract from the umbrella).
 */
/**
 * Manager-side planned dispatches. The upstream v1 `applyNode` mutation
 * was split into `applyNodeDraft` (DB write) + `applyAgentConfig` (notify)
 * in review-web 0.33.0 (Phase Node-12, #333). The BFF mirrors that split
 * with two dispatch kinds so each stage can fail and retry independently
 * within the same `ApplyAttempt` row.
 */
export interface ManagerPlannedDispatch {
  dispatchId: string;
  kind: "MANAGER_DB" | "MANAGER_NOTIFY";
  state: DispatchState;
  attemptCount: number;
  lastError: string | null;
  /**
   * Per-dispatch lock token for the post-DB fan-out phase (#550).
   * Present only while the dispatch is `in_flight` under the
   * claim-per-dispatch model; cleared when the dispatch finalises.
   * Row-level claims (DB stage, retries) never set this.
   */
  lockToken?: string;
  /**
   * Per-dispatch claim start time (ISO-8601), paired with `lockToken`
   * for stale-claim recovery during the post-DB phase. Cleared when
   * the dispatch finalises.
   */
  claimStartedAt?: string;
}

export interface ExternalPlannedDispatch {
  dispatchId: string;
  kind: "DATA_STORE" | "TI_CONTAINER";
  state: DispatchState;
  attemptCount: number;
  lastError: string | null;
  /**
   * Frozen `new` payload set at plan-build time. Authoritative for
   * external retries — by the time a retry runs the manager step has
   * already promoted / cleared the draft, so re-reading it would
   * surface a different value than the operator confirmed.
   */
  new: string;
  /**
   * Optional snapshot of the previously-applied config at plan-build
   * time. Carried verbatim through the `updateConfig` mutation as
   * `old` for the manager-side conflict check.
   */
  old?: string;
  /**
   * Per-dispatch lock token for the post-DB fan-out phase (#550).
   * Present only while the dispatch is `in_flight` under the
   * claim-per-dispatch model; cleared when the dispatch finalises.
   */
  lockToken?: string;
  /** Per-dispatch claim start time (ISO-8601). See `lockToken`. */
  claimStartedAt?: string;
}

export type PlannedDispatch = ManagerPlannedDispatch | ExternalPlannedDispatch;

/**
 * Database row shape for `apply_attempts`. Matches the migration
 * 0023_apply_attempts.sql columns one-to-one.
 */
export interface ApplyAttemptRow {
  attemptId: string;
  nodeId: string;
  draftFingerprint: Buffer;
  plannedDispatches: PlannedDispatch[];
  /**
   * Owner of the row. NULL only when the creator's account was deleted
   * AND the row was preserved by the round-8 audit-recovery rule
   * (`status = 'succeeded' AND succeeded_audit_completed_at IS NULL`).
   * For every other code path the column is non-NULL — the
   * BEFORE-DELETE trigger on `accounts` deletes non-audit-pending
   * rows outright, and `audit_actor` carries the snapshot used by
   * audit recovery regardless of cascade fate.
   */
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  executingLock: string | null;
  claimStartedAt: Date | null;
  status: ApplyAttemptStatus;
  /**
   * Owning customer id snapshotted at attempt-creation time. NULL only
   * for nodes that carry no `customerId` on either profile — reachable
   * exclusively by globally-scoped callers (see `enforceNodeScope`).
   * Read by both audit emitters so `node.apply` rows populate
   * `audit_logs.customer_id` and remain visible to a tenant-scoped
   * audit-log viewer.
   */
  customerId: number | null;
}

/**
 * Public response shape returned by `createApplyAttempt`.
 *
 * `draftFingerprint` is the lower-case hex-encoded SHA-256 of the
 * canonical-key-order JSON of the involved manager-DB draft state at
 * plan-build time. The caller passes it back unchanged on confirm so
 * the post-claim recompute (step 5b) can detect drift.
 */
export interface CreateApplyAttemptResult {
  attemptId: string;
  plannedDispatches: PlannedDispatch[];
  draftFingerprint: string;
  expiresAt: string;
}

/**
 * JSON-serializable apply-attempt row shape for server-action responses.
 *
 * The persisted row uses `Buffer` + `Date`, but Next server actions hand
 * this object to client components. Convert binary/time fields to strings
 * before crossing that boundary.
 */
export interface ApplyAttemptClientRow {
  attemptId: string;
  nodeId: string;
  draftFingerprint: string;
  plannedDispatches: PlannedDispatch[];
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  executingLock: string | null;
  claimStartedAt: string | null;
  status: ApplyAttemptStatus;
  customerId: number | null;
}

/**
 * The dispatcher interface that the post-claim executor invokes for
 * each planned dispatch.
 *
 * `_internal_confirmApplyAttempt` and `_internal_retryDispatch` take
 * an instance of this interface as a **required** argument — they
 * have no production default. #361 will export real server actions
 * that wrap the internal entry points and bind a production
 * dispatcher; this PR ships only test-only mocks (no GraphQL
 * mutation reaches the wire from this PR's exported surface).
 */
export interface ApplyDispatcher {
  /**
   * Dispatch the manager `applyNodeDraft` mutation (DB write only).
   * Receives the freshly-built `NodeInput` derived from the manager-DB
   * state read at step 5a — NOT a frozen plan-time payload. Throws on
   * failure (the error message is recorded as `lastError`).
   */
  managerDb(input: ManagerDbDispatchInput): Promise<void>;

  /**
   * Dispatch the manager `applyAgentConfig` mutation (agent notify
   * only). Runs after `managerDb` succeeds. Throws on failure; if any
   * `attempts[i].succeeded` is `false` the implementation surfaces a
   * dedicated error type so the lifecycle can record the failed agent
   * keys.
   */
  managerNotify(input: ManagerNotifyDispatchInput): Promise<void>;

  /**
   * Dispatch the per-service `updateConfig` mutation against the given
   * external service. Receives the frozen `old` / `new` payload from
   * the planned dispatch (durability contract). Throws on failure.
   */
  external(
    serviceKind: "DATA_STORE" | "TI_CONTAINER",
    input: ExternalDispatchInput,
  ): Promise<void>;
}

export interface ManagerDbDispatchInput {
  attemptId: string;
  nodeId: string;
  /**
   * The freshly-recomputed `NodeInput` from manager-DB state at
   * dispatch time. Typed as `unknown` here so this types module does
   * not pull in the full Node graph; the lifecycle module casts it to
   * the production `NodeInput` before invoking the dispatcher.
   */
  nodeInput: unknown;
}

export interface ManagerNotifyDispatchInput {
  attemptId: string;
  nodeId: string;
  /**
   * Scoping for the notify call. `null` notifies every agent on the
   * node (per Decision 5 in #333 — v1 bulk apply targets everyone).
   * Per-agent scoping is the lever a future per-agent UX would pull.
   */
  agentKeys: string[] | null;
}

/**
 * @deprecated Retained as an alias for source-compat with code paths that
 * have not yet migrated off the v1 single-stage manager dispatcher.
 * New code should use `ManagerDbDispatchInput` or
 * `ManagerNotifyDispatchInput` directly.
 */
export type ManagerDispatchInput = ManagerDbDispatchInput;

export interface ExternalDispatchInput {
  attemptId: string;
  dispatchId: string;
  oldConfig: string;
  newConfig: string;
}

/**
 * Default values for the three TTL knobs the umbrella exposes. All
 * three are configurable via environment variables (see `.env.example`
 * and `README.md`).
 */
export const APPLY_ATTEMPT_TTL_MS_DEFAULT = 30 * 60 * 1000; // 30 minutes
export const APPLY_ATTEMPT_RETENTION_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days
export const APPLY_EXECUTING_STALE_MS_DEFAULT = 2.5 * 60 * 60 * 1000; // 2.5 hours

/**
 * Per-dispatch retry cap. Once `attemptCount` reaches this value the
 * dispatch is hard-locked into `failed_terminal` regardless of any
 * remaining row TTL.
 */
export const APPLY_DISPATCH_MAX_ATTEMPTS_DEFAULT = 3;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getAttemptTtlMs(): number {
  return readPositiveIntEnv(
    "APPLY_ATTEMPT_TTL_MS",
    APPLY_ATTEMPT_TTL_MS_DEFAULT,
  );
}

export function getAttemptRetentionMs(): number {
  return readPositiveIntEnv(
    "APPLY_ATTEMPT_RETENTION_MS",
    APPLY_ATTEMPT_RETENTION_MS_DEFAULT,
  );
}

export function getExecutingStaleMs(): number {
  return readPositiveIntEnv(
    "APPLY_EXECUTING_STALE_MS",
    APPLY_EXECUTING_STALE_MS_DEFAULT,
  );
}

export function getDispatchMaxAttempts(): number {
  return readPositiveIntEnv(
    "APPLY_DISPATCH_MAX_ATTEMPTS",
    APPLY_DISPATCH_MAX_ATTEMPTS_DEFAULT,
  );
}

/**
 * Abandonment lastError written to in_flight / queued dispatches when
 * stale-lock recovery cascades a row into `failed_terminal`.
 */
export const ABANDONMENT_LAST_ERROR =
  "Abandoned by stale-lock recovery (executor lost claim)";
