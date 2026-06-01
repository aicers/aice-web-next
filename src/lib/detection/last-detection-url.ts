/**
 * `sessionStorage` persistence for the most recent Detection URL query
 * string (issue #668).
 *
 * Why this exists: the sidebar Detection link is a bare `/detection`
 * route with no query string. An in-app (SPA) navigation away to
 * another top-level menu unmounts {@link DetectionTabsShell} — which
 * discards every tab's in-memory result cache — and a return click
 * lands on the bare route. The server then bootstraps a *fresh* default
 * tab with a default-window query, and the rehydrated tabs from
 * `tabs-storage` come back with an empty result cache (`hasQueried:
 * false`), so the operator's previous active tab and its results are
 * lost. A full reload (F5) does not reproduce this because the address
 * bar still holds the active tab's `?f=...&tab=...` blob.
 *
 * The fix (option 3 in #668): remember the active Detection URL's query
 * string here while the shell is mounted, then have the sidebar
 * Detection link reconstruct `/detection?<search>` on return so the SPA
 * path hits the exact same SSR restore path F5 already uses.
 *
 * Scope isolation: the stored value carries filter contents, so it is
 * namespaced by the same `(account, customerIds)` scope fingerprint as
 * `tabs-storage` — a sign-out / sign-in or scope swap in the same
 * browser tab reads `null` and the link falls back to the bare
 * `/detection` default bootstrap. (Mirrors `tabsStorageKey`.)
 *
 * Only the query string rides here (no result rows, no leading `?`),
 * so the value stays tiny and well under the `sessionStorage` quota.
 */

export const LAST_URL_KEY_PREFIX = "detection:last-url:v1";
const PAYLOAD_VERSION = 1 as const;

/**
 * Age beyond which a stored URL is treated as expired and ignored.
 * `sessionStorage` already dies with the browser tab, so this is a
 * secondary guard against restoring a filter the operator built in a
 * long-idle tab. On expiry the link falls back to the bare
 * `/detection` default bootstrap.
 */
export const LAST_URL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Defensive cap so a corrupt / oversized payload can't be restored. */
const MAX_SEARCH_LENGTH = 8192;

interface StoredLastUrl {
  version: typeof PAYLOAD_VERSION;
  /** Query string without the leading `?`. */
  search: string;
  /** Epoch ms when the value was written; gates {@link LAST_URL_MAX_AGE_MS}. */
  savedAt: number;
}

/**
 * Per-scope `sessionStorage` key. Mirrors `tabsStorageKey`: a `null`
 * fingerprint (no `ScopeFingerprintProvider`, e.g. tests / sign-out
 * path) makes every operation a no-op so one scope's filter can never
 * leak into another.
 */
export function lastDetectionUrlKey(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  return `${LAST_URL_KEY_PREFIX}:${fingerprint}`;
}

export function serializeLastDetectionUrl(search: string, now: number): string {
  const payload: StoredLastUrl = {
    version: PAYLOAD_VERSION,
    search,
    savedAt: now,
  };
  return JSON.stringify(payload);
}

/**
 * Decode a stored payload back into a bare query string, or `null` on
 * any structural mismatch, expiry, or empty / oversized value so the
 * caller falls back to the bare `/detection` default bootstrap rather
 * than restoring a broken filter.
 */
export function parseLastDetectionUrl(
  raw: string | null,
  now: number,
): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Partial<StoredLastUrl>;
  if (payload.version !== PAYLOAD_VERSION) return null;
  if (
    typeof payload.savedAt !== "number" ||
    !Number.isFinite(payload.savedAt)
  ) {
    return null;
  }
  if (now - payload.savedAt > LAST_URL_MAX_AGE_MS) return null;
  if (typeof payload.search !== "string") return null;
  const search = payload.search;
  if (search.length === 0 || search.length > MAX_SEARCH_LENGTH) return null;
  return search;
}

/**
 * Persist the active Detection URL's query string. Best-effort: quota /
 * privacy-mode errors and a `null` fingerprint all fold into a no-op,
 * which simply means the next sidebar return falls back to the bare
 * `/detection` route.
 */
export function writeLastDetectionUrl(
  search: string,
  fingerprint: string | null,
  now: number = Date.now(),
): void {
  if (typeof window === "undefined") return;
  const key = lastDetectionUrlKey(fingerprint);
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, serializeLastDetectionUrl(search, now));
  } catch {
    // Ignored — see the module comment; a dropped write just means the
    // sidebar return falls back to the bare `/detection` bootstrap.
  }
}

/**
 * Read the stored Detection query string for the given scope, or `null`
 * when absent / expired / malformed. See {@link writeLastDetectionUrl}
 * for the `fingerprint` contract.
 */
export function readLastDetectionUrl(
  fingerprint: string | null,
  now: number = Date.now(),
): string | null {
  if (typeof window === "undefined") return null;
  const key = lastDetectionUrlKey(fingerprint);
  if (!key) return null;
  try {
    return parseLastDetectionUrl(window.sessionStorage.getItem(key), now);
  } catch {
    return null;
  }
}

/** Drop the stored URL. Used by tests and any future reset affordance. */
export function clearLastDetectionUrl(fingerprint: string | null): void {
  if (typeof window === "undefined") return;
  const key = lastDetectionUrlKey(fingerprint);
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignored — see `writeLastDetectionUrl`.
  }
}

/**
 * Build the in-app href the sidebar Detection link should navigate to.
 * Returns `/detection?<search>` when a valid stored URL exists for the
 * scope, or `null` to signal "use the bare route".
 */
export function resolveDetectionReturnHref(
  fingerprint: string | null,
  now: number = Date.now(),
): string | null {
  const search = readLastDetectionUrl(fingerprint, now);
  if (!search) return null;
  return `/detection?${search}`;
}
