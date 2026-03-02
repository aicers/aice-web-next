import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * AsyncLocalStorage instance for propagating correlation IDs through
 * the async call stack within a single request.
 *
 * ## Boundary rules
 *
 * ALS propagation is reliable only within the same Node.js async context:
 *
 * | Scope                         | Works? | Approach                            |
 * |-------------------------------|--------|-------------------------------------|
 * | Route Handlers                | Yes    | Auto-read via `getCorrelationId()`  |
 * | Server Actions                | Yes    | Auto-read via `getCorrelationId()`  |
 * | `instrumentation.ts` hooks    | Yes    | Auto-read via `getCorrelationId()`  |
 * | Next.js Middleware (Edge)     | No     | Separate execution context          |
 * | React Server Components       | No     | React concurrent scheduling         |
 * | Background jobs / detached    | No     | Pass `correlationId` explicitly     |
 *
 * When ALS context is unavailable, callers **must** pass `correlationId`
 * explicitly to `auditLog.record()`.
 *
 * ## Trust policy
 *
 * `correlation_id` is always generated server-side via `crypto.randomUUID()`.
 * External headers (`X-Request-ID`, `X-Correlation-ID`, W3C `traceparent`)
 * are **not** accepted as `correlation_id` to preserve audit integrity.
 * If external request tracing is needed, store the external ID in a separate
 * field (e.g., `details.external_request_id`).
 */
const storage = new AsyncLocalStorage<string>();

/**
 * Generate a new correlation ID (UUID v4).
 *
 * Always server-generated — never derived from external input.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Execute `fn` within a correlation ID context.
 *
 * All calls to `getCorrelationId()` within `fn` (including nested async
 * calls) will return the given `id`. Supports both sync and async `fn`.
 */
export function withCorrelationId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn);
}

/**
 * Read the current correlation ID from the async context.
 *
 * Returns `undefined` if called outside a `withCorrelationId()` context
 * (e.g., background jobs, detached promises, Middleware, RSC).
 */
export function getCorrelationId(): string | undefined {
  return storage.getStore();
}
