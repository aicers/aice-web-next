import "server-only";

import { redirect } from "next/navigation";

import { query } from "@/lib/db/client";

import { getAccessTokenCookie } from "./cookies";
import type { AuthSession } from "./jwt";
import { verifyJwtFull } from "./jwt";
import { hasPermission } from "./permissions";

// ── Session mutations ──────────────────────────────────────────

/**
 * Mark a session as revoked in the database.
 */
export async function revokeSession(sid: string): Promise<void> {
  await query("UPDATE sessions SET revoked = true WHERE sid = $1", [sid]);
}

// ── RSC session helpers ────────────────────────────────────────

/**
 * Read and verify the current session from the auth cookie.
 *
 * Extracted from `withAuth` steps 1-2 as a pure function usable in
 * Server Components and layouts.  Returns `null` when there is no
 * valid session (missing cookie, expired token, revoked session, etc.).
 */
export async function getCurrentSession(): Promise<AuthSession | null> {
  const token = await getAccessTokenCookie();
  if (!token) return null;

  try {
    return await verifyJwtFull(token);
  } catch {
    return null;
  }
}

/**
 * Assert that the session holds the given permission.
 *
 * Redirects to the root path if the permission is missing.  Intended
 * for page-level guards in React Server Components.
 */
export async function requirePermission(
  session: AuthSession,
  permission: string,
): Promise<void> {
  if (!(await hasPermission(session.roles, permission))) {
    redirect("/");
  }
}
