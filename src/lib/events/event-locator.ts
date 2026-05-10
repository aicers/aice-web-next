/**
 * Menu-neutral event locator.
 *
 * REview's `Event` interface exposes a stable, opaque `id: ID!` that
 * uniquely addresses an event under the current storage key format
 * (review-web#841). The locator wraps that identifier in a URL-safe
 * token so the in-app `/events/<token>` route and other deep-link
 * surfaces can address a single event without composing a filter.
 *
 * This module lives under `src/lib/events/` rather than
 * `src/lib/detection/` because sibling menus (Triage, etc.) are
 * expected to reuse the same encoder/decoder. Keeping it
 * menu-neutral avoids import cycles when those menus arrive.
 *
 * Token format: `base64url(JSON({ id }))`. Decoding validates only
 * that the payload is an object whose `id` is a non-empty,
 * bounded-length string. The `id` is treated as opaque — REview
 * documents that consumers must not parse it — so no semantic
 * checks on its contents apply. An invalid or tampered token
 * produces a `null` so callers render a documented "Invalid event
 * link" state rather than forwarding tampered values to REview.
 */

/**
 * Minimum event shape required to build a locator. The curated
 * `Event` union exposes `id` on every subtype (it is part of the
 * `Event` interface), so the locator is encodable for every event.
 */
export interface EventLocatorSource {
  id: string;
}

/**
 * Decoded token payload. Carries an opaque, REview-issued event
 * identifier — consumers must not parse it.
 */
export interface EventLocator {
  id: string;
}

/**
 * Upper bound on the decoded `id` length. REview documents the
 * value as opaque, so the bound exists only to reject obviously
 * tampered tokens (e.g. arbitrarily long strings) before forwarding
 * them. The actual encoding is generous — much shorter in practice.
 */
const MAX_ID_LENGTH = 1024;

function toBase64Url(input: string): string {
  const base64 = Buffer.from(input, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encode an event's identifier into a URL-safe token. Returns
 * `null` only when the event has no `id` (the curated `Event` union
 * always carries one in practice, so callers can treat this as
 * total).
 */
export function encodeEventLocator(event: EventLocatorSource): string | null {
  if (typeof event.id !== "string" || event.id.length === 0) return null;
  const payload: EventLocator = { id: event.id };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode a locator token. Returns `null` for malformed or
 * tampered tokens so the caller can render the documented
 * "event no longer available" state.
 */
export function decodeEventLocator(token: string): EventLocator | null {
  if (!token) return null;
  const json = fromBase64Url(token);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { id } = parsed as Record<string, unknown>;
  if (typeof id !== "string") return null;
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return null;

  return { id };
}
