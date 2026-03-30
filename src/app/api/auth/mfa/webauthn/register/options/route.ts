import "server-only";

import type { Base64URLString } from "@simplewebauthn/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import {
  bufferToBase64url,
  getRelyingParty,
  getWebAuthnCredentials,
  storeRegistrationChallenge,
} from "@/lib/auth/webauthn";
import { query } from "@/lib/db/client";

/**
 * POST /api/auth/mfa/webauthn/register/options
 *
 * Generate WebAuthn registration options (attestation challenge).
 */
export const POST = withAuth(async (_request, _context, session) => {
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

  // Step 2: Get RP config and existing credentials for excludeCredentials
  const rp = getRelyingParty();
  const existing = await getWebAuthnCredentials(session.accountId);

  // Step 3: Look up username for the user entity
  const { rows } = await query<{ username: string }>(
    "SELECT username FROM accounts WHERE id = $1",
    [session.accountId],
  );
  const username = rows[0]?.username ?? session.accountId;

  // Step 4: Generate registration options
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: username,
    userDisplayName: username,
    excludeCredentials: existing.map((cred) => ({
      id: bufferToBase64url(cred.credentialId) as Base64URLString,
      transports: cred.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    attestationType: "none",
  });

  // Step 5: Store challenge in DB
  await storeRegistrationChallenge(session.accountId, options.challenge);

  return NextResponse.json(options);
});

type AuthenticatorTransport = "usb" | "ble" | "nfc" | "internal";
