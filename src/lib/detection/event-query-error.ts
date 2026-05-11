import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

import { DetectionForbiddenError, DetectionUnauthorizedError } from "./errors";
import type { Filter } from "./filter";

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
 * Translate a thrown error from a `searchEventsAtAnchor` dispatch into
 * the typed discriminator the Detection UI consumes. Shared between
 * the client-callable {@link runEventQuery} action and the SSR
 * bootstrap path in the Detection page so a tampered URL / stale
 * saved filter / mid-session scope change on a cold load surfaces the
 * same `forbidden-sensor-scope` classification (and the same in-place
 * recovery affordance) as a client-side Apply would.
 *
 * `ReviewUnknownGraphQLError` is re-thrown: review answered with a
 * code we don't classify, and masking that as a graceful state would
 * defeat the security guardrail. Callers handle the re-throw via
 * their own error boundary.
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
  if (err instanceof ReviewForbiddenError) {
    // #278: the customer-scope leg already throws
    // `DetectionForbiddenError` before any review round-trip, so a
    // `ReviewForbiddenError` reaching here with a non-empty `sensors`
    // filter is unambiguously review-web 0.33.0's sensor-out-of-scope
    // path. Surface the IDs so the shell can resolve cached names and
    // offer the one-click drop / refresh recovery.
    const sensors =
      filter.mode === "structured" ? (filter.input.sensors ?? []) : [];
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
