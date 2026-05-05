/**
 * Client-side helpers for the Double-Submit CSRF pattern this app uses
 * on mutating Route Handler / Server Action calls.
 *
 * `src/lib/auth/csrf.ts` is `import "server-only"` — it validates the
 * token on the server.  This module is the corresponding client read /
 * attach path so any "use client" component making a mutating fetch
 * does not have to re-roll the cookie name lookup or header attach.
 */

/**
 * Read the CSRF token from the cookie (non-httpOnly).
 *
 * Production uses the `__Host-csrf` cookie name; development uses the
 * unprefixed `csrf` name (the `__Host-` prefix requires `secure`,
 * which `next dev` cannot serve).  Both names are checked and the
 * `__Host-` variant wins when both happen to be present.
 */
export function readCsrfToken(): string | null {
  for (const name of ["__Host-csrf", "csrf"]) {
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${name}=`));
    if (match) return match.split("=")[1] ?? null;
  }
  return null;
}

/**
 * `fetch()` wrapper for mutating endpoints (POST / PUT / PATCH /
 * DELETE).  Reads the Double-Submit CSRF cookie via {@link readCsrfToken}
 * and attaches it as the `x-csrf-token` request header that
 * `src/lib/auth/csrf.ts` validates server-side.
 *
 * Without this header the endpoint returns 403 even when the user is
 * authenticated, so any new client-initiated mutation should route
 * through this helper rather than calling `fetch()` directly.
 */
export async function mutatingFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const csrfToken = readCsrfToken();
  const headers = new Headers(init.headers);
  if (csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }
  return fetch(input, { ...init, headers });
}
