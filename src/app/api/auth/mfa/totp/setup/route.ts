import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import {
  buildTotpUri,
  enrollTotp,
  generateTotpSecret,
  getTotpCredential,
} from "@/lib/auth/totp";
import { query } from "@/lib/db/client";

/**
 * POST /api/auth/mfa/totp/setup
 *
 * Start TOTP enrollment. Generates a secret and returns a QR code URI.
 */
export const POST = withAuth(
  async (_request, _context, session) => {
    // Step 1: Check MFA policy allows TOTP
    const policy = await loadMfaPolicy();
    if (!policy.allowedMethods.includes("totp")) {
      return NextResponse.json(
        { error: "TOTP is not allowed by policy", code: "TOTP_NOT_ALLOWED" },
        { status: 405 },
      );
    }

    // Step 2: Check for existing verified credential
    const existing = await getTotpCredential(session.accountId);
    if (existing?.verified) {
      return NextResponse.json(
        { error: "TOTP is already enrolled", code: "TOTP_ALREADY_ENROLLED" },
        { status: 409 },
      );
    }

    // Step 3: Generate secret and enroll (upsert replaces any pending setup)
    const secret = generateTotpSecret();
    const enrolled = await enrollTotp(session.accountId, secret);
    if (!enrolled) {
      // Concurrent verify-setup activated the credential between steps 2-3
      return NextResponse.json(
        { error: "TOTP is already enrolled", code: "TOTP_ALREADY_ENROLLED" },
        { status: 409 },
      );
    }

    // Step 4: Look up username for the URI label
    const { rows } = await query<{ username: string }>(
      "SELECT username FROM accounts WHERE id = $1",
      [session.accountId],
    );
    const username = rows[0]?.username ?? session.accountId;

    // Step 5: Build otpauth:// URI
    const uri = buildTotpUri(secret, username);

    return NextResponse.json({ secret, uri });
  },
  { skipMfaEnrollCheck: true },
);
