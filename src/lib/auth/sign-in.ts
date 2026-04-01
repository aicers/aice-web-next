import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import {
  setAccessTokenCookie,
  setTokenExpCookie,
  setTokenTtlCookie,
} from "@/lib/auth/cookies";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  generateCsrfToken,
} from "@/lib/auth/csrf";
import { issueAccessToken } from "@/lib/auth/jwt";
import { loadJwtPolicy } from "@/lib/auth/jwt-policy";
import { extractBrowserFingerprint } from "@/lib/auth/ua-parser";
import { query } from "@/lib/db/client";

/**
 * Create a new session, issue JWT + CSRF tokens, set cookies,
 * and log a successful sign-in.
 */
export async function createSessionAndIssueTokens(params: {
  accountId: string;
  roleName: string;
  tokenVersion: number;
  mustChangePassword: boolean;
  mustEnrollMfa?: boolean;
  locale: string | null;
  ip: string;
  userAgent: string;
}): Promise<NextResponse> {
  const {
    accountId,
    roleName,
    tokenVersion,
    mustChangePassword,
    mustEnrollMfa = false,
    locale,
    ip,
    userAgent,
  } = params;

  // Reset failed count, lockout count, and update last_sign_in_at
  await query(
    `UPDATE accounts
     SET failed_sign_in_count = 0, lockout_count = 0, last_sign_in_at = NOW()
     WHERE id = $1`,
    [accountId],
  );

  // Create session
  const browserFingerprint = extractBrowserFingerprint(userAgent);
  const { rows: sessionRows } = await query<{ sid: string }>(
    `INSERT INTO sessions (sid, account_id, ip_address, user_agent, browser_fingerprint, must_enroll_mfa)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING sid`,
    [accountId, ip, userAgent, browserFingerprint, mustEnrollMfa],
  );
  const sessionId = sessionRows[0].sid;

  // Issue JWT
  const jwt = await issueAccessToken({
    accountId,
    sessionId,
    roles: [roleName],
    tokenVersion,
  });

  // Issue CSRF token
  const csrfSecret = process.env.CSRF_SECRET;
  if (!csrfSecret) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 },
    );
  }
  const { token: csrfToken } = generateCsrfToken(sessionId, csrfSecret);

  // Read JWT policy for cookie maxAge
  const jwtPolicy = await loadJwtPolicy();
  const maxAge = jwtPolicy.accessTokenExpirationMinutes * 60;

  // Set cookies
  const tokenExp = Math.floor(Date.now() / 1000) + maxAge;
  await setAccessTokenCookie(jwt, maxAge);
  await setTokenExpCookie(tokenExp, maxAge);
  await setTokenTtlCookie(maxAge);
  const cookieStore = await cookies();
  cookieStore.set(CSRF_COOKIE_NAME, csrfToken, {
    ...CSRF_COOKIE_OPTIONS,
    maxAge,
  });

  // Set NEXT_LOCALE cookie for next-intl locale negotiation
  if (locale) {
    cookieStore.set("NEXT_LOCALE", locale, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
  }

  // Audit success
  await auditLog.record({
    actor: accountId,
    action: "auth.sign_in.success",
    target: "session",
    targetId: sessionId,
    ip,
    sid: sessionId,
  });

  return NextResponse.json({ mustChangePassword, mustEnrollMfa });
}
