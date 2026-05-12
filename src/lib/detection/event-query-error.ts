import {
  classifyReviewSensorScopeError,
  type EventQueryClassification,
  type EventQueryErrorCode,
} from "@/lib/review/event-query-error";

import { DetectionForbiddenError, DetectionUnauthorizedError } from "./errors";
import type { Filter } from "./filter";

export type { EventQueryClassification, EventQueryErrorCode };

/**
 * Translate a thrown error from a `searchEventsAtAnchor` dispatch into
 * the typed discriminator the Detection UI consumes. Shared between
 * the client-callable {@link runEventQuery} action and the SSR
 * bootstrap path in the Detection page so a tampered URL / stale
 * saved filter / mid-session scope change on a cold load surfaces the
 * same `forbidden-sensor-scope` classification (and the same in-place
 * recovery affordance) as a client-side Apply would.
 *
 * Detection's own error classes (`DetectionForbiddenError`,
 * `DetectionUnauthorizedError`) are handled here; everything else is
 * delegated to {@link classifyReviewSensorScopeError} in
 * `@/lib/review/event-query-error`, which is the shared core reused
 * by Triage's Tier 2 sensor pivot (#502).
 *
 * `ReviewUnknownGraphQLError` is re-thrown by the shared helper:
 * review answered with a code we don't classify, and masking that as
 * a graceful state would defeat the security guardrail. Callers
 * handle the re-throw via their own error boundary.
 */
export function classifyEventQueryError(
  err: unknown,
  filter: Filter,
): EventQueryClassification {
  if (err instanceof DetectionForbiddenError) {
    return { code: "forbidden-customer-scope" };
  }
  if (err instanceof DetectionUnauthorizedError) {
    return { code: "forbidden" };
  }
  // #278: the customer-scope leg already throws
  // `DetectionForbiddenError` before any review round-trip, so a
  // `ReviewForbiddenError` reaching the shared classifier with a
  // non-empty `sensors` filter is unambiguously review-web 0.33.0's
  // sensor-out-of-scope path. Derive `sensors` from the structured
  // filter once and delegate.
  const sensors =
    filter.mode === "structured" ? (filter.input.sensors ?? []) : [];
  return classifyReviewSensorScopeError(err, sensors);
}
