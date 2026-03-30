import "server-only";

import type { Base64URLString } from "@simplewebauthn/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { verifyMfaToken } from "@/lib/auth/mfa-token";
import type { AuthenticatorTransport } from "@/lib/auth/webauthn";
import {
  bufferToBase64url,
  getRelyingParty,
  getWebAuthnCredentials,
  storeAuthenticationChallenge,
} from "@/lib/auth/webauthn";
import { query } from "@/lib/db/client";

/**
 * POST /api/auth/mfa/webauthn/challenge/options
 *
 * Generate WebAuthn authentication options (assertion challenge).
 * Pre-authentication — no session required, uses mfaToken instead.
 */
async function handleOptions(request: NextRequest): Promise<NextResponse> {
  // Step 1: Parse body
  let body: { mfaToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { mfaToken } = body;
  if (!mfaToken) {
    return NextResponse.json(
      { error: "mfaToken is required" },
      { status: 400 },
    );
  }

  // Step 2: Verify mfaToken JWT
  let accountId: string;
  let jti: string;
  try {
    const payload = await verifyMfaToken(mfaToken);
    accountId = payload.sub;
    jti = payload.jti;
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // Step 3: Check mfa_challenges table (exists, not used)
  const { rows: challengeRows } = await query<{ used: boolean }>(
    "SELECT used FROM mfa_challenges WHERE jti = $1",
    [jti],
  );

  if (challengeRows.length === 0 || challengeRows[0].used) {
    return NextResponse.json(
      { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // Step 4: Policy check
  const mfaPolicy = await loadMfaPolicy();
  if (!mfaPolicy.allowedMethods.includes("webauthn")) {
    return NextResponse.json(
      {
        error: "WebAuthn is not allowed by policy",
        code: "WEBAUTHN_NOT_ALLOWED",
      },
      { status: 403 },
    );
  }

  // Step 5: Get credentials and generate options
  const credentials = await getWebAuthnCredentials(accountId);
  if (credentials.length === 0) {
    return NextResponse.json(
      {
        error: "WebAuthn is not allowed by policy",
        code: "WEBAUTHN_NOT_ALLOWED",
      },
      { status: 403 },
    );
  }

  const rp = getRelyingParty();
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: credentials.map((cred) => ({
      id: bufferToBase64url(cred.credentialId) as Base64URLString,
      transports: cred.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: "preferred",
  });

  // Step 6: Store challenge in DB (keyed by jti so concurrent logins don't collide)
  await storeAuthenticationChallenge(accountId, jti, options.challenge);

  return NextResponse.json(options);
}

// ── Route export ────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = generateCorrelationId();
  return withCorrelationId(correlationId, () => handleOptions(request));
}
