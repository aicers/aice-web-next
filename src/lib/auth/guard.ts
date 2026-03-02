import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { query } from "@/lib/db/client";

import { getAccessTokenCookie } from "./cookies";
import type { AuthSession } from "./jwt";
import { verifyJwtFull } from "./jwt";

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

// ── Public API ──────────────────────────────────────────────────

/**
 * Higher-order function that wraps Route Handlers with authentication.
 *
 * 1. Reads the access token from the cookie
 * 2. Verifies the token (stateless + DB checks)
 * 3. Checks must_change_password → 403 with redirect indicator
 * 4. Updates session last_active_at
 * 5. Calls the wrapped handler with the authenticated session
 */
export function withAuth(handler: AuthenticatedHandler): RouteHandler {
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

    // Step 3: Check must_change_password
    if (session.mustChangePassword) {
      return NextResponse.json(
        { error: "Password change required", redirect: "/change-password" },
        { status: 403 },
      );
    }

    // Step 4: Update last_active_at on the session
    await query("UPDATE sessions SET last_active_at = NOW() WHERE sid = $1", [
      session.sessionId,
    ]);

    // Step 5: Invoke the authenticated handler
    return handler(request, context, session);
  };
}
