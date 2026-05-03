import "server-only";

import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "./errors";

interface GraphQLLikeError {
  message?: string;
  extensions?: { code?: string };
}

/**
 * Inspect a `graphql-request` rejection's `response.errors[]` for a
 * known review-side classification. Returns the typed error to throw
 * in place of the raw rejection, or `null` if the failure should
 * propagate unchanged.
 *
 * Failures with no GraphQL `errors[]` payload (transport drops,
 * timeouts, mTLS handshake failures, BFF bugs, …) return `null` so
 * the existing transport / not-found / unknown-error paths still
 * apply and the catch sites can degrade gracefully.
 *
 * Failures that *do* carry an `errors[]` payload but no recognised
 * code are wrapped in {@link ReviewUnknownGraphQLError}. Per #405's
 * security guardrails the catch must not broaden to "all GraphQL
 * errors → graceful state": a future review-side error code we
 * don't recognise must continue to throw past the route's graceful
 * fallback so operators see a real failure and the BFF gets a
 * follow-up classification commit. Returning a plain `Error` (or
 * the original rejection) is not enough — Reviewer Round 2 P1
 * called out that the catch sites convert any plain `Error` into
 * the generic `server-error` / banner state, which is the same
 * masking the guardrail forbids.
 */
function classifyReviewErrors(error: unknown): Error | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors || errors.length === 0) return null;

  let unknownMessage: string | null = null;
  for (const e of errors) {
    const code = e?.extensions?.code;
    const message = typeof e?.message === "string" ? e.message : "";
    if (code === "FORBIDDEN" || /^forbidden\b/i.test(message)) {
      return new ReviewForbiddenError(message || "Forbidden", { cause: error });
    }
    if (
      code === "BAD_USER_INPUT" ||
      /first and last must be within/i.test(message) ||
      /invalid argument/i.test(message)
    ) {
      return new ReviewInvalidArgumentError(message || "Invalid argument", {
        cause: error,
      });
    }
    if (unknownMessage === null && message.length > 0) {
      unknownMessage = message;
    }
  }
  return new ReviewUnknownGraphQLError(
    unknownMessage ?? "Unclassified review GraphQL error",
    { cause: error },
  );
}

/**
 * Wrap a review-bound GraphQL dispatch and translate known review
 * `errors[]` payloads into typed BFF errors. Connection-level
 * failures and unrecognised GraphQL errors propagate unchanged so
 * the existing transport / not-found / unknown-error paths still
 * apply.
 *
 * Intended to wrap `graphqlRequest(...)` calls that target review
 * (the "manager"), upstream of `withManagerErrorMapping` —
 * `withManagerErrorMapping` only inspects `isConnectionError`, so
 * stacking the two is order-independent for the cases each one
 * cares about.
 */
export async function withReviewErrorMapping<T>(
  promise: Promise<T>,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const classified = classifyReviewErrors(err);
    if (classified) throw classified;
    throw err;
  }
}
