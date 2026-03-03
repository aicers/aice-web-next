// Edge Runtime compatible — no "server-only", no node:* imports, no DB

import { routing } from "@/i18n/routing";

// Canonical source: src/lib/auth/cookies.ts (ACCESS_TOKEN_COOKIE)
// Duplicated here to avoid "server-only" import in proxy code.
export const AUTH_COOKIE_NAME = "at";

// Paths that do NOT require authentication. Everything else that
// matches the proxy matcher is protected (fail-closed).
const PUBLIC_PATHS = new Set(["/", "/sign-in"]);

/**
 * Strip the locale prefix from a pathname if present.
 * "/ko/audit-logs" → "/audit-logs", "/audit-logs" → "/audit-logs"
 */
function stripLocalePrefix(pathname: string): string {
  for (const locale of routing.locales) {
    const prefix = `/${locale}`;
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length);
    }
  }
  return pathname;
}

/** True if the path does not require authentication. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(stripLocalePrefix(pathname));
}
