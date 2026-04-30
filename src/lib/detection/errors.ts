/**
 * Error thrown when a caller lacks `detection:read`. Server actions
 * throw this **before** dispatching to REview so unauthorized requests
 * never hit the network.
 *
 * Note: empty customer scope is **not** routed through this error —
 * see {@link DetectionForbiddenError}. The caller holds
 * `detection:read`, so the actionable failure is "no customers in
 * scope", which belongs in the customer-scope gate alongside the
 * out-of-scope filter case.
 */
export class DetectionUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionUnauthorizedError";
  }
}

/**
 * Thrown by server actions when they are called in a filter mode
 * that is not yet wired up (currently: `mode: "query"`).
 *
 * Kept distinct from `DetectionUnauthorizedError` so callers can
 * distinguish a forward-compatibility stub from an authorization
 * failure.
 */
export class DetectionNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionNotImplementedError";
  }
}

/**
 * Thrown by server actions when the inbound `Filter` references
 * customers the caller cannot access — e.g. a saved filter activated
 * by another account, a crafted URL blob, or a pivot URL whose
 * `customers` list exceeds the caller's effective scope.
 *
 * Kept distinct from {@link DetectionUnauthorizedError} so the route
 * layer can distinguish "not authorized for Detection at all"
 * (caller lacks `detection:read`) from "authorized for Detection
 * but the customer-scope gate failed". The latter is actionable —
 * the operator can drop the offending IDs from the filter and
 * retry, or contact an admin about an empty assignment — while the
 * former is not. Empty-scope sessions also throw this error
 * (Reviewer Round 2 on #384): the caller holds `detection:read` but
 * has no customers in scope, the same family of failure as a crafted
 * filter referencing customers outside scope.
 *
 * Per the project's defense-in-depth principle (REview is not the
 * only enforcement point): every Detection server action validates
 * `filter.input.customers` against the caller's effective scope
 * before any REview round-trip. A failed check produces a typed
 * rejection here, never a silent narrowing of the filter.
 */
export class DetectionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionForbiddenError";
  }
}
