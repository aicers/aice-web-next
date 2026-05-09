/**
 * Pure helpers used by the Triage pivot dimension extractors:
 *
 *   - registrable-domain extraction via the Public Suffix List
 *     (delegated to `tldts`, which is browser-safe and tree-shakable).
 *   - URI-pattern templating (numeric segments → `{id}`, UUID-like
 *     segments → `{uuid}`, hex-blob segments → `{hex}`).
 *   - IP-literal validation (used to gate DNS answer pivot values to
 *     actual address tokens).
 *
 * The pivot index ships in the baseline subtree, so this module must
 * stay free of any import from the policy modules under
 * `src/lib/triage/policy/` — see #447 §6 deprecatable seam.
 */

import { getDomain } from "tldts";

/**
 * Half-window for the "same kind within ±15 min" pivot, in
 * milliseconds. Two events of the same `__typename` are considered
 * neighbors when their times fall within this delta of a focus event.
 */
export const TRIAGE_SAME_KIND_WINDOW_MS = 15 * 60 * 1000;

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

const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * `true` when `value` is a textual IPv4 or IPv6 literal. Used to gate
 * DNS-answer pivot values to actual address tokens — REview's
 * `event.answer` field is a flat string that may contain CNAMEs,
 * status text, or other non-address payload, and the dimension's
 * contract is "answer IP", not "answer string".
 *
 * This is a syntactic check; it does not validate that the address
 * is reachable or that an IPv6 literal is canonically shortened.
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is recognized.
 */
export function isIpLiteral(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes(":")) return isIpv6Literal(value);
  return isIpv4Literal(value);
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => IPV4_OCTET.test(part));
}

function isIpv6Literal(value: string): boolean {
  // Reject anything that is not [0-9a-f:.] since IPv6 may also embed
  // an IPv4 tail (`::ffff:1.2.3.4`).
  if (!/^[0-9a-f:.]+$/i.test(value)) return false;
  // Three or more colons in a row is never valid (`:::` is not a
  // legal "::" compression).
  if (/:{3,}/.test(value)) return false;
  // At most one "::" run.
  const doubleColons = value.match(/::/g);
  const hasZeroRun = doubleColons !== null && doubleColons.length === 1;
  if (doubleColons && doubleColons.length > 1) return false;

  let head = value;
  let ipv4Tail: string | null = null;
  // Pull out an embedded IPv4 tail if present.
  const lastColon = value.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : value.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIpv4Literal(tail)) return false;
    ipv4Tail = tail;
    head = value.slice(0, lastColon);
  }

  const groups = head.split(":");
  // The IPv4 tail counts as the last two 16-bit groups.
  const maxGroups = ipv4Tail ? 6 : 8;
  const filled = groups.filter((g) => g.length > 0);
  if (filled.length > maxGroups) return false;
  if (hasZeroRun) {
    // A `::` run requires at least one omitted group; otherwise the
    // address is fully written and the run is spurious.
    if (filled.length >= maxGroups) return false;
  } else {
    if (groups.length !== maxGroups) return false;
    if (groups.some((g) => g.length === 0)) return false;
  }
  return groups.every((g) => g === "" || /^[0-9a-f]{1,4}$/i.test(g));
}
