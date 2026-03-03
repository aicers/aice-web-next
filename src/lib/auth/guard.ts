import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { query } from "@/lib/db/client";
import { checkApiRateLimit } from "@/lib/rate-limit/limiter";

import { getAccessTokenCookie } from "./cookies";
import {
  CSRF_HEADER_NAME,
  isMutationMethod,
  validateCsrfToken,
  validateOrigin,
} from "./csrf";
import type { AuthSession } from "./jwt";
import { verifyJwtFull } from "./jwt";
import { rotateTokens, shouldRotate } from "./rotation";

// ── Types ───────────────────────────────────────────────────────

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<NextResponse | Response>;

type AuthenticatedHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<NextResponse | Response>;

// ── Options ─────────────────────────────────────────────────────

interface WithAuthOptions {
  /**
   * When `true`, skip the must-change-password check (step 5).
   * Needed for endpoints like sign-out that must remain accessible
   * even when a password change is pending.
   */
  skipPasswordCheck?: boolean;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Higher-order function that wraps Route Handlers with authentication,
 * rate limiting, CSRF protection, and sliding token rotation.
 *
 * 1. Reads the access token from the cookie
 * 2. Verifies the token (stateless + DB checks)
 * 3. Per-user API rate limit → 429 with Retry-After
 * 4. For mutation methods (POST/PUT/PATCH/DELETE):
 *    a. Validates Origin/Referer header
 *    b. Validates CSRF token from X-CSRF-Token header
 * 5. Checks must_change_password → 403 with redirect indicator
 *    (skippable via `options.skipPasswordCheck`)
 * 6. Updates session last_active_at
 * 7. Calls the wrapped handler with the authenticated session
 * 8. Sliding rotation — re-issues JWT + CSRF when ≤ 1/3 lifetime
 *    remains
 *
 * Server Actions are naturally exempt — they do not go through Route
 * Handlers and have Next.js built-in CSRF protection.
 */
export function withAuth(
  handler: AuthenticatedHandler,
  options?: WithAuthOptions,
): RouteHandler {
  return async (request, context) => {
    // Step 1: Read token from cookie
    const token = await getAccessTokenCookie();
    if (!token) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Step 2: Full JWT verification (stateless + DB checks)
    let session: AuthSession;
    try {
      session = await verifyJwtFull(token);
    } catch {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 },
      );
    }

    // Step 3: Per-user API rate limit
    const rateLimitResult = await checkApiRateLimit(session.accountId);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimitResult.retryAfterSeconds),
          },
        },
      );
    }

    // Step 4: CSRF validation for mutation methods
    if (isMutationMethod(request.method)) {
      const csrfSecret = process.env.CSRF_SECRET;
      if (!csrfSecret) {
        return NextResponse.json(
          { error: "Server configuration error" },
          { status: 500 },
        );
      }

      // Step 4a: Origin / Referer verification
      if (
        !validateOrigin(
          request.headers.get("origin"),
          request.headers.get("referer"),
          request.nextUrl.origin,
        )
      ) {
        return NextResponse.json({ error: "Origin mismatch" }, { status: 403 });
      }

      // Step 4b: CSRF token verification
      const csrfToken = request.headers.get(CSRF_HEADER_NAME);
      if (
        !csrfToken ||
        !validateCsrfToken(
          csrfToken,
          session.sessionId,
          csrfSecret,
          session.iat,
        )
      ) {
        return NextResponse.json(
          { error: "Invalid CSRF token" },
          { status: 403 },
        );
      }
    }

    // Step 5: Check must_change_password (skippable)
    if (!options?.skipPasswordCheck && session.mustChangePassword) {
      return NextResponse.json(
        { error: "Password change required", redirect: "/change-password" },
        { status: 403 },
      );
    }

    // Step 6: Update last_active_at on the session
    await query("UPDATE sessions SET last_active_at = NOW() WHERE sid = $1", [
      session.sessionId,
    ]);

    // Step 7: Invoke the authenticated handler
    const response = await handler(request, context, session);

    // Step 8: Sliding rotation — re-issue tokens when nearing expiry
    if (shouldRotate(session.iat, session.exp)) {
      await rotateTokens(session);
    }

    return response;
  };
}
