/**
 * URL persistence for the Quick peek selected event (Phase
 * Detection-18).
 *
 * The selected event's locator token (see
 * `@/lib/events/event-locator`) is mirrored into a dedicated
 * `event` query param so a page refresh restores the peek on the
 * active tab. Parsing is strict so a tampered or stale token falls
 * through to "no peek open" rather than crashing the shell; this
 * module only encodes / decodes — locator validation itself lives
 * in the shared `@/lib/events/event-locator` module.
 *
 * The token rides on the existing pivot / free-form filter search
 * params rather than in a hash fragment so it survives SSR and
 * RSS-style links shared from the address bar.
 */
import {
  decodeEventLocator,
  type EventLocator,
} from "@/lib/events/event-locator";

export const QUICK_PEEK_EVENT_PARAM = "event";

/**
 * Read the Quick peek locator from a `URLSearchParams`-like view.
 * Returns `null` when the param is absent or fails strict validation,
 * so the caller can render a quiet "no peek" state rather than
 * crashing on a typo'd share link. The raw token is returned
 * alongside the decoded locator so callers can match list events by
 * re-encoding (token equality, not deep field equality).
 */
export function readQuickPeekToken(source: {
  get: (name: string) => string | null;
}): { token: string; locator: EventLocator } | null {
  const token = source.get(QUICK_PEEK_EVENT_PARAM);
  if (!token) return null;
  const locator = decodeEventLocator(token);
  if (!locator) return null;
  return { token, locator };
}

/**
 * Produce a new search string for `window.history.replaceState` with
 * the Quick peek event param set, added, or removed. The caller is
 * responsible for combining the result with the current pathname —
 * this helper only touches the `event` param so pivot / free-form
 * filter params stay untouched.
 */
export function applyQuickPeekToken(
  searchString: string,
  token: string | null,
): string {
  const params = new URLSearchParams(searchString);
  if (token) {
    params.set(QUICK_PEEK_EVENT_PARAM, token);
  } else {
    params.delete(QUICK_PEEK_EVENT_PARAM);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
