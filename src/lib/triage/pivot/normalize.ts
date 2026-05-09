/**
 * Pure helpers used by the Triage pivot dimension extractors:
 *
 *   - registrable-domain extraction via the Public Suffix List
 *     (delegated to `tldts`, which is browser-safe and tree-shakable).
 *   - URI-pattern templating (numeric segments → `{id}`, UUID-like
 *     segments → `{uuid}`, hex-blob segments → `{hex}`).
 *
 * The pivot index ships in the baseline subtree, so this module must
 * stay free of any import from the policy modules under
 * `src/lib/triage/policy/` — see #447 §6 deprecatable seam.
 */

import { getDomain } from "tldts";

/** 30-min bucket size in milliseconds for the time/structure pivot. */
export const TRIAGE_TIME_BUCKET_MS = 30 * 60 * 1000;

/**
 * Extract the registrable domain ("eTLD+1") from a raw `host` /
 * server-name string.
 *
 * Returns `null` when the input is empty, an IP literal, or otherwise
 * not a valid hostname. `tldts` consults the Public Suffix List with
 * private domains enabled, so multi-level public suffixes such as
 * `*.s3.amazonaws.com` and `*.co.uk`, plus IDN inputs, all produce
 * the operator-meaningful registrable domain.
 */
export function extractRegistrableDomain(
  host: string | null | undefined,
): string | null {
  if (typeof host !== "string") return null;
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  // Strip an optional `:port` suffix from a host header value before
  // handing it to tldts — `getDomain("example.com:8443")` returns
  // null because the colon makes it parse as a malformed URL.
  const withoutPort = trimmed.replace(/:\d+$/, "");
  const domain = getDomain(withoutPort, { allowPrivateDomains: true });
  return domain && domain.length > 0 ? domain.toLowerCase() : null;
}

const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_BLOB_SEGMENT = /^[0-9a-f]{16,}$/i;

/**
 * Normalize a URI to a pivot-stable pattern.
 *
 * The query string is stripped (operators pivot on path shape, not
 * per-request parameters). Path segments are templated:
 *
 *   - all-numeric segments → `{id}`
 *     (e.g. `/api/v1/users/42` → `/api/v1/users/{id}`)
 *   - canonical UUIDs       → `{uuid}`
 *     (e.g. `/files/3fa85f64-…afa6` → `/files/{uuid}`)
 *   - 16+ char pure-hex     → `{hex}`
 *     (e.g. `/objects/abc123…ef` → `/objects/{hex}`; covers Git-style
 *      SHAs and similar opaque object IDs without lumping them into
 *      `{id}` where they would compete with surrogate-key paths)
 *
 * Returns `null` when the input is empty / whitespace.
 */
export function normalizeUriPattern(
  uri: string | null | undefined,
): string | null {
  if (typeof uri !== "string") return null;
  const trimmed = uri.trim();
  if (trimmed.length === 0) return null;

  // Strip query string and fragment, but keep the leading slash so a
  // bare `?token=foo` still produces a meaningful pattern.
  const queryAt = trimmed.search(/[?#]/);
  const pathOnly = queryAt === -1 ? trimmed : trimmed.slice(0, queryAt);
  if (pathOnly.length === 0) return null;

  // Preserve a single trailing slash flavor: the templated path must
  // round-trip the input's leading-slash convention so two events
  // that both hit `/api/v1/users/42` and `users/42` stay distinct.
  const segments = pathOnly.split("/").map((segment) => {
    if (segment.length === 0) return segment;
    if (NUMERIC_SEGMENT.test(segment)) return "{id}";
    if (UUID_SEGMENT.test(segment)) return "{uuid}";
    if (HEX_BLOB_SEGMENT.test(segment)) return "{hex}";
    return segment;
  });
  return segments.join("/");
}

/**
 * Bucket an ISO-8601 timestamp to a 30-minute window for the
 * "same kind within ±15 min" pivot. Returns `null` when the input is
 * not parseable.
 *
 * Two events fall into the same bucket iff their times round down to
 * the same 30-minute boundary. Worst-case in-window separation is
 * ~30 min when the events sit at opposite ends of the same bucket;
 * the issue allows the implementer to set the grain so long as the
 * dimension stays operator-meaningful.
 */
export function timeBucketKey(time: string | null | undefined): number | null {
  if (typeof time !== "string" || time.length === 0) return null;
  const ms = Date.parse(time);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / TRIAGE_TIME_BUCKET_MS);
}
