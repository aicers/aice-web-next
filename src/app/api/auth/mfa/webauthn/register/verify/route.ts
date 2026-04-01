import "server-only";

import type {
  RegistrationResponseJSON,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import {
  generateRecoveryCodes,
  getRecoveryCodeCount,
} from "@/lib/auth/recovery-codes";
import {
  base64urlToUint8Array,
  consumeRegistrationChallenge,
  getRelyingParty,
  storeWebAuthnCredential,
} from "@/lib/auth/webauthn";

/**
 * POST /api/auth/mfa/webauthn/register/verify
 *
 * Verify WebAuthn registration response (attestation verification).
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Check MFA policy allows WebAuthn
    const policy = await loadMfaPolicy();
    if (!policy.allowedMethods.includes("webauthn")) {
      return NextResponse.json(
        {
          error: "WebAuthn is not allowed by policy",
          code: "WEBAUTHN_NOT_ALLOWED",
        },
        { status: 405 },
      );
    }

    // Step 2: Parse body
    let response: RegistrationResponseJSON;
    let displayName: string | undefined;
    try {
      const body = await request.json();
      response = body.response;
      displayName = body.displayName;
      if (!response) {
        return NextResponse.json(
          { error: "Missing required field: response" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Step 3: Retrieve stored challenge
    const expectedChallenge = await consumeRegistrationChallenge(
      session.accountId,
    );
    if (!expectedChallenge) {
      return NextResponse.json(
        {
          error: "No pending registration challenge found",
          code: "WEBAUTHN_CHALLENGE_NOT_FOUND",
        },
        { status: 400 },
      );
    }

    // Step 4: Verify registration response
    const rp = getRelyingParty();
    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
      });
    } catch {
      return NextResponse.json(
        {
          error: "WebAuthn verification failed",
          code: "WEBAUTHN_VERIFICATION_FAILED",
        },
        { status: 400 },
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json(
        {
          error: "WebAuthn verification failed",
          code: "WEBAUTHN_VERIFICATION_FAILED",
        },
        { status: 400 },
      );
    }

    // Step 5: Store the credential
    const { credential } = verification.registrationInfo;
    const credentialIdBytes = base64urlToUint8Array(credential.id);

    const credentialDbId = await storeWebAuthnCredential({
      accountId: session.accountId,
      credentialId: credentialIdBytes,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      displayName,
    });

    // Step 6: Audit log
    await auditLog.record({
      actor: session.accountId,
      action: "mfa.webauthn.register",
      target: "mfa",
      targetId: session.accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    // Step 7: Auto-generate recovery codes if first MFA method
    const { total } = await getRecoveryCodeCount(session.accountId);
    let recoveryCodes: string[] | undefined;
    if (total === 0) {
      recoveryCodes = await generateRecoveryCodes(session.accountId);

      await auditLog.record({
        actor: session.accountId,
        action: "mfa.recovery.generate",
        target: "mfa",
        targetId: session.accountId,
        ip: extractClientIp(request),
        sid: session.sessionId,
        details: { reason: "auto_first_enrollment" },
      });
    }

    return NextResponse.json({
      success: true,
      credential: {
        id: credentialDbId,
        displayName: displayName ?? null,
        createdAt: new Date().toISOString(),
      },
      ...(recoveryCodes ? { recoveryCodes } : {}),
    });
  },
  { skipMfaEnrollCheck: true },
);
