/**
 * Typed errors that classify GraphQL-layer failures from review-web
 * (a.k.a. the "manager"). Lives in a review-layer module so both
 * Node and Detection can import without a layering violation —
 * `lib/node/...` already carries `ManagerUnavailableError` /
 * `NodeNotFoundError` for transport- and operation-specific
 * failures, but Forbidden / argument-validation are review-wide
 * concerns rather than Node-specific ones.
 *
 * The previous `withManagerErrorMapping` only inspected
 * `isConnectionError` (transport-level), so review's GraphQL
 * `errors[]` (status 200, payload denial) propagated as a raw
 * `Error` and surfaced as a 500 page. Routes that wrap a dispatch
 * with the new {@link withReviewErrorMapping} (or call sites that
 * apply it explicitly) catch the typed error and return a graceful
 * status — 403 for Forbidden, 400 for argument-validation —
 * instead of crashing the page tree.
 */

/**
 * Thrown when review responds (status 200) with
 * `errors[].message === "Forbidden"`. Distinct from the Node /
 * Detection BFF's own permission errors because the failure
 * happened on review's side — the BFF sent a request that review
 * accepted at the transport layer but rejected at the resolver.
 *
 * Routes treat this as a 403; server-component / page bootstrap
 * paths render an explicit access-denied panel instead of crashing.
 *
 * Critically, this must NOT be used to silently swallow a denied
 * response as "no data" — see issue #405's security guardrails.
 * Mapping the error class to a status code preserves the
 * semantically distinct "denied" state in the UI.
 */
export class ReviewForbiddenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewForbiddenError";
  }
}

/**
 * Thrown when review responds (status 200) with an argument-
 * validation error such as
 * `"The value of first and last must be within 0-100"`. Surfaces
 * BFF-versus-review contract drift as a 400 rather than a 500 so
 * the route can prompt a retry / refresh instead of presenting a
 * crash page.
 *
 * The shipped BFF caps page sizes at `REVIEW_MAX_PAGE_SIZE` (#405
 * J), so this class is defense-in-depth: a future drift in either
 * side should not 500 the user-visible page.
 */
export class ReviewInvalidArgumentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewInvalidArgumentError";
  }
}

/**
 * Thrown when review responds (status 200) with an `errors[]`
 * payload whose `extensions.code` / `message` does not match any
 * known classification. Distinct from a transport / connection
 * failure: this signals review *did* answer, but with a code the
 * BFF was not taught to recognise — e.g. a new review-side error
 * code added in a later release.
 *
 * #405's security guardrail forbids the catch sites from
 * broadening to "all GraphQL errors → graceful state": an
 * unrecognised review error must continue to throw so operators
 * see a real failure (and the BFF gets a follow-up classification
 * commit) rather than the route silently degrading to "no data".
 * Reviewer Round 2 P1: every catch site that returns a graceful
 * `server-error` / generic-banner state must let this class
 * propagate, while still translating ordinary expected failures
 * (transport drops, BFF bugs) into the existing graceful states.
 */
export class ReviewUnknownGraphQLError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewUnknownGraphQLError";
  }
}
