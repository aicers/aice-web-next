import "server-only";

import { ReviewForbiddenError, ReviewInvalidArgumentError } from "./errors";

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
 * Unknown `errors[].message` strings deliberately return `null`: per
 * #405's security guardrails, the catch must not broaden to "all
 * GraphQL errors → graceful state" — a future review-side error code
 * we don't recognise must continue to throw so we don't accidentally
 * mask it.
 */
function classifyReviewErrors(error: unknown): Error | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors || errors.length === 0) return null;

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
  }
  return null;
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
