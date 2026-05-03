import { describe, expect, it } from "vitest";

import { withReviewErrorMapping } from "@/lib/review/error-mapping";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

/**
 * Build a graphql-request-shaped rejection: a generic `Error` whose
 * `response.errors[]` carries the GraphQL-layer payload review
 * returns under a 200 with classified failures.
 */
function gqlError(
  errors: Array<{ message?: string; extensions?: { code?: string } }>,
): Error {
  const err = new Error("ClientError");
  (err as Error & { response: unknown }).response = { errors };
  return err;
}

describe("withReviewErrorMapping", () => {
  it("maps `errors[].message === 'Forbidden'` to ReviewForbiddenError", async () => {
    await expect(
      withReviewErrorMapping(
        Promise.reject(gqlError([{ message: "Forbidden" }])),
      ),
    ).rejects.toBeInstanceOf(ReviewForbiddenError);
  });

  it("maps `extensions.code === 'FORBIDDEN'` to ReviewForbiddenError", async () => {
    await expect(
      withReviewErrorMapping(
        Promise.reject(
          gqlError([
            { message: "permission denied", extensions: { code: "FORBIDDEN" } },
          ]),
        ),
      ),
    ).rejects.toBeInstanceOf(ReviewForbiddenError);
  });

  it("maps the page-size validation message to ReviewInvalidArgumentError", async () => {
    // The exact message review 0.47.0 returns when `first` / `last`
    // exceed 100. The BFF caps page sizes (#405 J), but the mapper
    // is defense-in-depth for future drift.
    await expect(
      withReviewErrorMapping(
        Promise.reject(
          gqlError([
            { message: "The value of first and last must be within 0-100" },
          ]),
        ),
      ),
    ).rejects.toBeInstanceOf(ReviewInvalidArgumentError);
  });

  it("maps `extensions.code === 'BAD_USER_INPUT'` to ReviewInvalidArgumentError", async () => {
    await expect(
      withReviewErrorMapping(
        Promise.reject(
          gqlError([{ message: "x", extensions: { code: "BAD_USER_INPUT" } }]),
        ),
      ),
    ).rejects.toBeInstanceOf(ReviewInvalidArgumentError);
  });

  it("wraps unknown `errors[].message` strings in ReviewUnknownGraphQLError (does not silently swallow)", async () => {
    // Per #405's security guard: the catch must NOT broaden to "all
    // GraphQL errors → graceful state". Reviewer Round 2 P1 found
    // that returning the raw error here let downstream catch sites
    // collapse it into the generic `server-error` / banner state —
    // exactly the masking the guard forbids. Wrapping in a typed
    // class lets every catch site rethrow it explicitly while still
    // collapsing ordinary plain `Error`s (transport drops, BFF
    // bugs) into the graceful state.
    const original = gqlError([{ message: "some-novel-review-failure" }]);
    let caught: unknown;
    try {
      await withReviewErrorMapping(Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewUnknownGraphQLError);
    expect((caught as Error).message).toBe("some-novel-review-failure");
    expect((caught as Error & { cause?: unknown }).cause).toBe(original);
  });

  it("wraps an empty unknown message in ReviewUnknownGraphQLError with a sentinel message", async () => {
    const original = gqlError([{ extensions: { code: "CUSTOM_FUTURE_CODE" } }]);
    let caught: unknown;
    try {
      await withReviewErrorMapping(Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewUnknownGraphQLError);
    expect((caught as Error).message).toBe("Unclassified review GraphQL error");
  });

  it("re-throws raw connection errors (no `response.errors[]` to inspect)", async () => {
    // The mapper only inspects `response.errors[]`. Connection-level
    // failures (`TypeError` from undici, no `response`) must
    // propagate so `withManagerErrorMapping` (Node's wrapper) maps
    // them to `ManagerUnavailableError`.
    const original = new TypeError("fetch failed");
    let caught: unknown;
    try {
      await withReviewErrorMapping(Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  it("preserves the original error as `cause`", async () => {
    const original = gqlError([{ message: "Forbidden" }]);
    let caught: unknown;
    try {
      await withReviewErrorMapping(Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewForbiddenError);
    expect((caught as Error & { cause?: unknown }).cause).toBe(original);
  });
});
