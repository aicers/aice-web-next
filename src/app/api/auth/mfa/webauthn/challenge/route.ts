import "server-only";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { auditLog } from "@/lib/audit/logger";
import { validateMfaChallenge } from "@/lib/auth/mfa-challenge";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { createSessionAndIssueTokens } from "@/lib/auth/sign-in";
import type { AuthenticatorTransport } from "@/lib/auth/webauthn";
import {
  base64urlToUint8Array,
  consumeAuthenticationChallenge,
  getRelyingParty,
  getWebAuthnCredentialByCredentialId,
  updateWebAuthnCounter,
} from "@/lib/auth/webauthn";
import { query } from "@/lib/db/client";

// ── Handler ─────────────────────────────────────────────────────

async function handleChallenge(request: NextRequest): Promise<NextResponse> {
  // Step 1: Parse body
  let body: { mfaToken?: string; response?: AuthenticationResponseJSON };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { mfaToken, response } = body;
  if (!mfaToken || !response) {
    return NextResponse.json(
      { error: "mfaToken and response are required" },
      { status: 400 },
    );
  }

  // Steps 2–6: Shared MFA challenge validation
  const result = await validateMfaChallenge(request, mfaToken);
  if (result instanceof NextResponse) return result;

  const { accountId, jti, account, ip } = result;

  // Step 5: Policy check (WebAuthn may have been disabled mid-flow)
  const mfaPolicy = await loadMfaPolicy();
  if (!mfaPolicy.allowedMethods.includes("webauthn")) {
    return NextResponse.json(
      {
        error: "WebAuthn is no longer allowed",
        code: "WEBAUTHN_NOT_ALLOWED",
      },
      { status: 403 },
    );
  }

  // Step 7: Retrieve stored challenge and verify WebAuthn assertion
  const expectedChallenge = await consumeAuthenticationChallenge(jti);
  if (!expectedChallenge) {
    return NextResponse.json(
      { error: "No pending challenge found", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // Look up the credential by the credential ID in the response
  const credentialIdBytes = base64urlToUint8Array(response.id);
  const credential =
    await getWebAuthnCredentialByCredentialId(credentialIdBytes);

  if (!credential || credential.accountId !== accountId) {
    await auditLog.record({
      actor: accountId,
      action: "mfa.webauthn.verify.failure",
      target: "mfa",
      targetId: accountId,
      ip,
    });
    return NextResponse.json(
      { error: "Invalid assertion", code: "INVALID_MFA_CODE" },
      { status: 401 },
    );
  }

  const rp = getRelyingParty();

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: response.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports:
          (credential.transports as AuthenticatorTransport[] | undefined) ??
          undefined,
      },
    });
  } catch {
    await auditLog.record({
      actor: accountId,
      action: "mfa.webauthn.verify.failure",
      target: "mfa",
      targetId: accountId,
      ip,
    });
    return NextResponse.json(
      { error: "Invalid assertion", code: "INVALID_MFA_CODE" },
      { status: 401 },
    );
  }

  if (!verification.verified) {
    await auditLog.record({
      actor: accountId,
      action: "mfa.webauthn.verify.failure",
      target: "mfa",
      targetId: accountId,
      ip,
    });
    return NextResponse.json(
      { error: "Invalid assertion", code: "INVALID_MFA_CODE" },
      { status: 401 },
    );
  }

  // Step 8: Update credential counter
  await updateWebAuthnCounter(
    credentialIdBytes,
    verification.authenticationInfo.newCounter,
  );

  // Step 9: Atomically consume token and create session
  const { rows: consumeRows } = await query<{ jti: string }>(
    "UPDATE mfa_challenges SET used = true WHERE jti = $1 AND used = false RETURNING jti",
    [jti],
  );

  if (consumeRows.length === 0) {
    return NextResponse.json(
      { error: "Token already used", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  await auditLog.record({
    actor: accountId,
    action: "mfa.webauthn.verify.success",
    target: "mfa",
    targetId: accountId,
    ip,
  });

  const userAgent = request.headers.get("user-agent") ?? "";

  return createSessionAndIssueTokens({
    accountId,
    roleName: account.role_name,
    tokenVersion: account.token_version,
    mustChangePassword: account.must_change_password,
    locale: account.locale,
    ip,
    userAgent,
  });
}

// ── Route export ────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = generateCorrelationId();
  return withCorrelationId(correlationId, () => handleChallenge(request));
}
