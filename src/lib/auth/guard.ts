import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { query } from "@/lib/db/client";
import { checkApiRateLimit } from "@/lib/rate-limit/limiter";

import { ACCESS_TOKEN_COOKIE } from "./cookies";
import {
  CSRF_HEADER_NAME,
  isMutationMethod,
  validateCsrfToken,
  validateOrigin,
} from "./csrf";
import { extractClientIp } from "./ip";
import type { AuthSession } from "./jwt";
import { verifyJwtFull } from "./jwt";
import { hasPermission } from "./permissions";
import { rotateTokens, shouldRotate } from "./rotation";
import { revokeSession } from "./session";
import {
  isAbsoluteTimedOut,
  isIdleTimedOut,
  loadSessionPolicy,
} from "./session-policy";
import { assessIpUaRisk } from "./session-validator";
import { extractBrowserFingerprint } from "./ua-parser";

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
   * When `true`, skip the must-change-password check.
   * Needed for endpoints like sign-out that must remain accessible
   * even when a password change is pending.
   */
  skipPasswordCheck?: boolean;
  /**
   * When `true`, skip session policy checks (timeouts, IP/UA,
   * re-auth gate).  Needed for the re-auth endpoint itself to
   * avoid a deadlock where re-auth is blocked by the re-auth gate.
   */
  skipSessionPolicy?: boolean;
  /**
   * Permissions the caller must hold (AND semantics — all listed
   * permissions must be present).  Checked after CSRF validation,
   * before session policy enforcement.  Returns 403 on failure.
   */
  requiredPermissions?: string[];
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Higher-order function that wraps Route Handlers with authentication,
 * rate limiting, CSRF protection, session policy enforcement, and
 * sliding token rotation.
 *
 *  1. Reads the access token from the cookie
 *  2. Verifies the token (stateless + DB checks)
 *  3. Per-user API rate limit → 429 with Retry-After
 *  4. For mutation methods (POST/PUT/PATCH/DELETE):
 *     a. Validates Origin/Referer header
 *     b. Validates CSRF token from X-CSRF-Token header
 *  4.5. Permission check → 403 if any required permission is missing
 *       (configurable via `options.requiredPermissions`, AND semantics)
 *  5. Session timeout check (idle + absolute)
 *  6. IP/UA change risk assessment
 *  7. Re-auth gate (if session.needs_reauth → 401)
 *  8. Checks must_change_password → 403 with redirect indicator
 *     (skippable via `options.skipPasswordCheck`)
 *  9. Updates session last_active_at
 * 10. Calls the wrapped handler with the authenticated session
 * 11. Sliding rotation — re-issues JWT + CSRF when ≤ 1/3 lifetime
 *     remains
 *
 * Steps 5-7 are skippable via `options.skipSessionPolicy`.
 */
export function withAuth(
  handler: AuthenticatedHandler,
  options?: WithAuthOptions,
): RouteHandler {
  return async (request, context) => {
    // Step 1: Read token from the request cookie directly (avoids
    // relying on the next/headers cookies() async context which can
    // break under certain server configurations).
    const token = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
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

    // Step 4.5: Permission check (AND semantics)
    if (options?.requiredPermissions) {
      for (const perm of options.requiredPermissions) {
        if (!(await hasPermission(session.roles, perm))) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
    }

    // Steps 5-7: Session policy enforcement (skippable)
    if (!options?.skipSessionPolicy) {
      // Step 5: Session timeout check
      const policy = await loadSessionPolicy();

      // 5a: Absolute timeout (non-negotiable)
      if (
        isAbsoluteTimedOut(
          session.sessionCreatedAt,
          policy.absoluteTimeoutHours,
        )
      ) {
        await revokeSession(session.sessionId);
        await auditLog.record({
          actor: session.accountId,
          action: "session.absolute_timeout",
          target: "session",
          targetId: session.sessionId,
          details: { reason: "absolute_timeout" },
          sid: session.sessionId,
        });
        return NextResponse.json(
          { error: "Session expired", code: "SESSION_EXPIRED" },
          { status: 401 },
        );
      }

      // 5b: Idle timeout
      if (
        isIdleTimedOut(session.sessionLastActiveAt, policy.idleTimeoutMinutes)
      ) {
        await revokeSession(session.sessionId);
        await auditLog.record({
          actor: session.accountId,
          action: "session.idle_timeout",
          target: "session",
          targetId: session.sessionId,
          details: { reason: "idle_timeout" },
          sid: session.sessionId,
        });
        return NextResponse.json(
          {
            error: "Session expired due to inactivity",
            code: "SESSION_IDLE_TIMEOUT",
          },
          { status: 401 },
        );
      }

      // Step 6: IP/UA change risk assessment
      const currentIp = extractClientIp(request);
      const currentUa = request.headers.get("user-agent") ?? "";
      const currentFingerprint = extractBrowserFingerprint(currentUa);

      const risk = assessIpUaRisk({
        storedIp: session.sessionIp,
        currentIp,
        storedBrowserFingerprint: session.sessionBrowserFingerprint,
        currentBrowserFingerprint: currentFingerprint,
      });

      // Record audit events for any detected changes
      for (const action of risk.auditActions) {
        await auditLog.record({
          actor: session.accountId,
          action,
          target: "session",
          targetId: session.sessionId,
          ip: currentIp,
          sid: session.sessionId,
          details: {
            riskLevel: risk.riskLevel,
            storedIp: session.sessionIp,
            currentIp,
            storedFingerprint: session.sessionBrowserFingerprint,
            currentFingerprint,
          },
        });
      }

      // If re-auth is required, flag the session
      if (risk.requiresReauth && !session.needsReauth) {
        await query("UPDATE sessions SET needs_reauth = true WHERE sid = $1", [
          session.sessionId,
        ]);
        session = { ...session, needsReauth: true };
      }

      // Step 7: Re-auth gate
      if (session.needsReauth) {
        return NextResponse.json(
          {
            error: "Re-authentication required",
            code: "REAUTH_REQUIRED",
          },
          { status: 401 },
        );
      }
    }

    // Step 8: Check must_change_password (skippable)
    if (!options?.skipPasswordCheck && session.mustChangePassword) {
      return NextResponse.json(
        { error: "Password change required", redirect: "/change-password" },
        { status: 403 },
      );
    }

    // Step 9: Update last_active_at on the session
    await query("UPDATE sessions SET last_active_at = NOW() WHERE sid = $1", [
      session.sessionId,
    ]);

    // Step 10: Invoke the authenticated handler
    const response = await handler(request, context, session);

    // Step 11: Sliding rotation — re-issue tokens when nearing expiry
    if (shouldRotate(session.iat, session.exp)) {
      await rotateTokens(session);
    }

    return response;
  };
}
