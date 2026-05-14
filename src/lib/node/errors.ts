/**
 * Error types raised by the Node management dispatch layer.
 *
 * Server actions in `src/lib/node/server-actions.ts` and the
 * service-type read abstraction in `src/lib/node/service-dispatch.ts`
 * map low-level GraphQL / network failures into these typed errors so
 * the UI can render the graceful-degradation states described in the
 * Node management umbrella (#306).
 */

/**
 * Thrown when a caller lacks the required permission, has no
 * resolvable customer scope, or attempts to operate on a node outside
 * their tenant scope. Server actions throw this **before** any GraphQL
 * request reaches the wire so unauthorized callers never touch the
 * upstream backend.
 */
export class NodePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodePermissionError";
  }
}

/**
 * Thrown when a node id has no matching record on review-web. Distinct
 * from `NodePermissionError` so the UI can render a 404 rather than a
 * 403, and from `ManagerUnavailableError` so it isn't conflated with a
 * transport failure.
 */
export class NodeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeNotFoundError";
  }
}

/**
 * Thrown when the manager (review-web) endpoint is unreachable —
 * connection refused, DNS failure, mTLS handshake failure, or
 * timeout. The raw network error is preserved as `cause` for logs but
 * not surfaced to the UI; callers map this to the manager-offline
 * banner state.
 */
export class ManagerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagerUnavailableError";
  }
}

/**
 * Thrown when a Giganto or Tivan endpoint is unreachable. Same
 * graceful-degradation contract as `ManagerUnavailableError`, but the
 * UI can still show a node's manager-side draft and snapshot — only
 * the per-service applied config and live status are missing.
 */
export class ExternalServiceUnavailableError extends Error {
  readonly serviceKind: ExternalServiceKindHint;
  constructor(
    serviceKind: ExternalServiceKindHint,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExternalServiceUnavailableError";
    this.serviceKind = serviceKind;
  }
}

/**
 * The two external service kinds aice-web-next can dispatch to. Kept
 * here (rather than in the service-dispatch module) so the error type
 * does not depend on it and the import graph stays acyclic.
 */
export type ExternalServiceKindHint = "DATA_STORE" | "TI_CONTAINER";

// ── ApplyAttempt lifecycle errors (Phase Node-9a, #359) ───────────

/**
 * Thrown when an `apply_attempts` row is not present (or has been
 * hard-deleted by retention cleanup) at the moment a confirm / retry
 * tries to claim it.
 */
export class ApplyAttemptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyAttemptNotFoundError";
  }
}

/**
 * Thrown when a confirm / retry hits an `apply_attempts` row already
 * held under another caller's `executing_lock`. The competing caller
 * is mid-dispatch — retrying is the caller's responsibility, the
 * server makes no automatic resumption.
 */
export class ApplyAttemptBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyAttemptBusyError";
  }
}

/**
 * Thrown when a confirm / retry hits an `apply_attempts` row already
 * in `failed_terminal` (cap exhausted, abandonment, hard fail). The
 * row will not transition further; the caller must build a new plan.
 */
export class ApplyAttemptTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyAttemptTerminalError";
  }
}

/**
 * Thrown when the manager-DB drafts have drifted from the planned
 * fingerprint (post-claim recompute mismatch in step 5b/5c) or the
 * row is in `stale` / `expired` at the moment of claim. The caller
 * must rebuild the plan from the latest manager-DB drafts.
 */
export class StalePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePlanError";
  }
}

/**
 * Thrown by `_internal_retryDispatch` when the supplied `dispatchId`
 * does not appear in the planned dispatches array.
 */
export class DispatchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchNotFoundError";
  }
}

/**
 * Thrown by `_internal_retryDispatch` when the target dispatch is in
 * a per-dispatch state that cannot be retried (`queued`, `in_flight`,
 * `succeeded`, or `failed_terminal`). Step 2b read-only check; no
 * row write is performed in this rejection.
 */
export class DispatchNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchNotRetryableError";
  }
}

/**
 * Thrown by a dispatcher to signal that the failure is structurally
 * non-retryable and the lifecycle should land the dispatch in
 * `failed_terminal` immediately, regardless of `APPLY_DISPATCH_MAX_ATTEMPTS`.
 *
 * Example: `applyAgentConfig` returns an error when the targeted node's
 * `hostname` is empty (Phase Node-12, #333) — no retry will succeed
 * until the operator edits the node's profile, so consuming retry slots
 * first wastes operator time and obscures the underlying cause.
 */
export class DispatchTerminalFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DispatchTerminalFailureError";
  }
}

/**
 * Thrown by `applyAgentConfig` dispatchers when one or more agents in
 * the result's `attempts[]` reported `succeeded: false`. The
 * `failedAgentKeys` array carries the bare agent keys whose notify
 * failed, so the lifecycle can record them in `lastError`.
 *
 * This failure is retryable: agent-side notify is idempotent per the
 * upstream contract, so a retry re-calls `applyAgentConfig` and the
 * already-succeeded agents are re-notified harmlessly.
 */
export class AgentNotifyPartialFailureError extends Error {
  readonly failedAgentKeys: string[];
  constructor(failedAgentKeys: string[]) {
    super(
      `applyAgentConfig reported failures for ${failedAgentKeys.length} agent(s): ${failedAgentKeys.join(", ")}`,
    );
    this.name = "AgentNotifyPartialFailureError";
    this.failedAgentKeys = failedAgentKeys;
  }
}
