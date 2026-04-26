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
