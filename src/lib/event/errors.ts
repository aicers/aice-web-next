/**
 * Domain errors for the Event-menu data layer.
 *
 * Transport-level Giganto failures (connection refused, DNS, mTLS,
 * timeout) are mapped to {@link ExternalServiceUnavailableError} via
 * the shared `withExternalErrorMapping` helper in
 * `@/lib/node/error-mapping`, so the Event lib only defines the
 * authorization error it raises before any request reaches the wire.
 */

/**
 * Thrown when a caller lacks `event:read` or has no resolvable customer
 * scope. Server actions throw this **before** any Giganto request
 * reaches the wire, so unauthorized callers never touch the upstream
 * data store.
 */
export class EventPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPermissionError";
  }
}
