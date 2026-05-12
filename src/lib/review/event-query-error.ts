import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "./errors";

/**
 * Review-layer classification of a thrown error from an
 * `eventList`-shaped dispatch. Shared between Detection's
 * `classifyEventQueryError` (which layers its own
 * `DetectionForbiddenError` / `DetectionUnauthorizedError` arms on
 * top) and Triage's Tier 2 sensor pivot (#502), which throws
 * `Review*` errors directly without a Detection-shaped filter.
 *
 * The shape stays Review-neutral on purpose — extending it to cover
 * every Triage error surface is explicitly out of scope (see #502
 * "Out of scope").
 */
export type EventQueryErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "forbidden-customer-scope"
  | "forbidden-sensor-scope"
  | "invalid-input"
  | "server-error";

export interface EventQueryClassification {
  code: EventQueryErrorCode;
  /**
   * Populated only when {@link code} is `"forbidden-sensor-scope"`.
   * Mirrors the `sensors` argument from the rejected dispatch so the
   * caller can render the "selection no longer accessible" affordance.
   */
  unavailableSensorIds?: readonly string[];
}

/**
 * Classify a Review-layer error against a known `sensors` argument.
 *
 *   - `ReviewForbiddenError` with a non-empty `sensors` array →
 *     `forbidden-sensor-scope` (review-web 0.33.0 tightened
 *     `eventList(filter: { sensors: [...] })` to return `Forbidden`
 *     when any supplied `nodeId` lies outside the caller's customer
 *     scope).
 *   - `ReviewForbiddenError` with an empty `sensors` array →
 *     `forbidden`.
 *   - `ReviewInvalidArgumentError` → `invalid-input`.
 *   - `ReviewUnknownGraphQLError` is re-thrown: review answered with
 *     a code we don't classify, and masking that as a graceful state
 *     would defeat the security guardrail.
 *   - Anything else → `server-error`.
 *
 * Callers that own a Detection- or Triage-shaped error class
 * hierarchy on top of these Review classes should handle their own
 * cases first and delegate the residual Review classification here.
 */
export function classifyReviewSensorScopeError(
  err: unknown,
  sensors: readonly string[],
): EventQueryClassification {
  if (err instanceof ReviewForbiddenError) {
    if (sensors.length > 0) {
      return { code: "forbidden-sensor-scope", unavailableSensorIds: sensors };
    }
    return { code: "forbidden" };
  }
  if (err instanceof ReviewInvalidArgumentError) {
    return { code: "invalid-input" };
  }
  if (err instanceof ReviewUnknownGraphQLError) {
    throw err;
  }
  return { code: "server-error" };
}
