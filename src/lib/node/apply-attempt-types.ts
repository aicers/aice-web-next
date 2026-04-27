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
export interface ManagerPlannedDispatch {
  dispatchId: string;
  kind: "MANAGER";
  state: DispatchState;
  attemptCount: number;
  lastError: string | null;
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
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  executingLock: string | null;
  claimStartedAt: Date | null;
  status: ApplyAttemptStatus;
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
   * Dispatch the manager `applyNode` mutation. Receives the freshly-
   * built `NodeInput` derived from the manager-DB state read at step
   * 5a — NOT a frozen plan-time payload. Throws on failure (the error
   * message is recorded as `lastError`).
   */
  manager(input: ManagerDispatchInput): Promise<void>;

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

export interface ManagerDispatchInput {
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
