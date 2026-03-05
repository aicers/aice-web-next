import "server-only";

import type { JWTPayload } from "jose";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

import { query } from "@/lib/db/client";

import { getSigningKey, getVerificationKey } from "./jwt-keys";

// ── Constants ───────────────────────────────────────────────────

const JWT_ISSUER = "aice-web-next";
const JWT_AUDIENCE = "aice-web-next";

const DEFAULT_EXPIRATION_MINUTES = 15;
const MIN_EXPIRATION_MINUTES = 5;
const MAX_EXPIRATION_MINUTES = 15;

// ── Types ───────────────────────────────────────────────────────

export interface AccessTokenPayload extends JWTPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  sid: string;
  roles: string[];
  token_version: number;
  kid: string;
}

export interface AuthSession {
  accountId: string;
  sessionId: string;
  roles: string[];
  tokenVersion: number;
  mustChangePassword: boolean;
  /** JWT issued-at timestamp (seconds since epoch). */
  iat: number;
  /** JWT expiration timestamp (seconds since epoch). */
  exp: number;
  // ── Session policy fields (populated from DB) ──────────────
  /** IP address stored at session creation (or last re-auth). */
  sessionIp: string;
  /** Full User-Agent string stored at session creation. */
  sessionUserAgent: string;
  /** Normalized browser fingerprint (e.g. `"Chrome/131"`). */
  sessionBrowserFingerprint: string;
  /** Whether the session requires re-authentication. */
  needsReauth: boolean;
  /** When the session was created. */
  sessionCreatedAt: Date;
  /** When the session was last active. */
  sessionLastActiveAt: Date;
}

// ── Issuance ────────────────────────────────────────────────────

export async function issueAccessToken(params: {
  accountId: string;
  sessionId: string;
  roles: string[];
  tokenVersion: number;
  expirationMinutes?: number;
}): Promise<string> {
  const { accountId, sessionId, roles, tokenVersion } = params;

  const expMinutes = Math.max(
    MIN_EXPIRATION_MINUTES,
    Math.min(
      MAX_EXPIRATION_MINUTES,
      params.expirationMinutes ?? DEFAULT_EXPIRATION_MINUTES,
    ),
  );

  const key = getSigningKey();

  return new SignJWT({
    sid: sessionId,
    roles,
    token_version: tokenVersion,
    kid: key.kid,
  })
    .setProtectedHeader({ alg: key.algorithm, kid: key.kid })
    .setIssuer(JWT_ISSUER)
    .setSubject(accountId)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expMinutes}m`)
    .sign(key.privateKey);
}

// ── Stateful verification ───────────────────────────────────────

/**
 * Fully verify a JWT: stateless checks (signature, exp, kid) plus
 * database checks (session exists + not revoked, account active,
 * token_version matches).
 */
export async function verifyJwtFull(token: string): Promise<AuthSession> {
  // Step 1: Decode header to get kid
  const header = decodeProtectedHeader(token);
  const kid = header.kid;

  if (!kid) {
    throw new Error("JWT header missing kid");
  }

  const keyInfo = getVerificationKey(kid);
  if (!keyInfo) {
    throw new Error(`No verification key found for kid: ${kid}`);
  }

  // Step 2: Verify signature, exp, iss, aud
  const { payload } = await jwtVerify<AccessTokenPayload>(
    token,
    keyInfo.publicKey,
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: [keyInfo.algorithm],
    },
  );

  // Step 3: Database checks — single JOIN query
  const { rows } = await query<{
    sid: string;
    revoked: boolean;
    ip_address: string;
    user_agent: string;
    browser_fingerprint: string;
    needs_reauth: boolean;
    created_at: string;
    last_active_at: string;
    token_version: number;
    status: string;
    must_change_password: boolean;
  }>(
    `SELECT s.sid, s.revoked, s.ip_address, s.user_agent,
            s.browser_fingerprint, s.needs_reauth,
            s.created_at, s.last_active_at,
            a.token_version, a.status, a.must_change_password
     FROM sessions s
     JOIN accounts a ON s.account_id = a.id
     WHERE s.sid = $1 AND s.account_id = $2`,
    [payload.sid, payload.sub],
  );

  if (rows.length === 0) {
    throw new Error("Session not found");
  }

  const row = rows[0];

  if (row.revoked) {
    throw new Error("Session has been revoked");
  }

  if (row.status !== "active") {
    throw new Error("Account is not active");
  }

  if (row.token_version !== payload.token_version) {
    throw new Error("Token version mismatch (token has been invalidated)");
  }

  return {
    accountId: payload.sub,
    sessionId: payload.sid,
    roles: payload.roles,
    tokenVersion: payload.token_version,
    mustChangePassword: row.must_change_password,
    iat: payload.iat,
    exp: payload.exp,
    sessionIp: row.ip_address,
    sessionUserAgent: row.user_agent,
    sessionBrowserFingerprint: row.browser_fingerprint,
    needsReauth: row.needs_reauth,
    sessionCreatedAt: new Date(row.created_at),
    sessionLastActiveAt: new Date(row.last_active_at),
  };
}
