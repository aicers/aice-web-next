import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { getWebAuthnCredentials } from "@/lib/auth/webauthn";

/**
 * GET /api/auth/mfa/webauthn/status
 *
 * Check WebAuthn enrollment status and policy state.
 * Policy-independent — always accessible.
 */
export const GET = withAuth(async (_request, _context, session) => {
  const [credentials, policy] = await Promise.all([
    getWebAuthnCredentials(session.accountId),
    loadMfaPolicy(),
  ]);

  return NextResponse.json({
    enrolled: credentials.length > 0,
    allowed: policy.allowedMethods.includes("webauthn"),
    credentialCount: credentials.length,
  });
});
