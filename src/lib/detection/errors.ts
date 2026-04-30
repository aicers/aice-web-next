/**
 * Error thrown when a caller lacks `detection:read` or has no
 * resolvable customer scope. Server actions throw this **before**
 * dispatching to REview so unauthorized requests never hit the
 * network.
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
 * (caller lacks `detection:read` or has empty scope) from
 * "authorized for Detection but this specific filter references
 * customers outside scope". The latter is actionable — the operator
 * can drop the offending IDs from the filter and retry — while the
 * former is not.
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
