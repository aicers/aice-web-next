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
