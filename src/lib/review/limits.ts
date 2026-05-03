/**
 * Hard limits enforced by review-web's GraphQL layer that the BFF must
 * respect. Centralised here so callers across Detection and Node share
 * a single source of truth — and so a future review release that
 * relaxes a limit only needs one update site.
 */

/**
 * Upper bound on Relay-style `first` / `last` arguments. Review 0.47.0
 * rejects anything outside `[0, 100]` with a GraphQL-level error
 * ("The value of first and last must be within 0-100"), which the
 * BFF surfaces as a 500 page if not capped here. Revisit if review
 * relaxes the limit on a later release.
 */
export const REVIEW_MAX_PAGE_SIZE = 100 as const;
