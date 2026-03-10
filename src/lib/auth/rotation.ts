import "server-only";

import { cookies } from "next/headers";

import { TOKEN_EXPIRATION_SECONDS } from "./constants";
import { setAccessTokenCookie, setTokenExpCookie } from "./cookies";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  generateCsrfToken,
} from "./csrf";
import type { AuthSession } from "./jwt";
import { issueAccessToken } from "./jwt";

// ── Constants ────────────────────────────────────────────────────

/**
 * Rotate when the remaining lifetime is ≤ 1/ROTATION_FRACTION of
 * the total lifetime.  For a 15-minute token this triggers at ≤ 5
 * minutes remaining.
 */
const ROTATION_FRACTION = 3;

type SessionTokenContext = Pick<
  AuthSession,
  "accountId" | "sessionId" | "roles" | "tokenVersion"
>;

// ── Public API ───────────────────────────────────────────────────

/**
 * Determine whether a JWT should be rotated based on its remaining
 * lifetime.
 *
 * @param iat  JWT issued-at (seconds since epoch)
 * @param exp  JWT expiration (seconds since epoch)
 * @returns `true` when remaining ≤ 1/3 of total and token is not
 *          already expired
 */
export function shouldRotate(iat: number, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const total = exp - iat;
  const remaining = exp - now;

  return remaining > 0 && remaining <= total / ROTATION_FRACTION;
}

/** Issue a new JWT + CSRF token pair and set them as cookies. */
export async function reissueAuthCookies(
  session: SessionTokenContext,
): Promise<boolean> {
  const csrfSecret = process.env.CSRF_SECRET;
  if (!csrfSecret) return false;

  // Issue new JWT
  const newToken = await issueAccessToken({
    accountId: session.accountId,
    sessionId: session.sessionId,
    roles: session.roles,
    tokenVersion: session.tokenVersion,
  });

  // Issue new CSRF token
  const { token: newCsrfToken } = generateCsrfToken(
    session.sessionId,
    csrfSecret,
  );

  // Set JWT cookie
  const tokenExp = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_SECONDS;
  await setAccessTokenCookie(newToken, TOKEN_EXPIRATION_SECONDS);
  await setTokenExpCookie(tokenExp, TOKEN_EXPIRATION_SECONDS);

  // Set CSRF cookie
  const cookieStore = await cookies();
  cookieStore.set(CSRF_COOKIE_NAME, newCsrfToken, {
    ...CSRF_COOKIE_OPTIONS,
    maxAge: TOKEN_EXPIRATION_SECONDS,
  });

  return true;
}

/**
 * Issue a new JWT + CSRF token pair and set them as cookies.
 *
 * Called by the `withAuth()` guard after the handler completes when
 * the current token is within the rotation window.  The previous
 * token is **not** revoked — it remains valid until its natural
 * expiration (automatic grace period).
 */
export async function rotateTokens(session: AuthSession): Promise<void> {
  await reissueAuthCookies(session);
}
