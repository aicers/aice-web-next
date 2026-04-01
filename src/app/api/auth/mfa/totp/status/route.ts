import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { getTotpCredential } from "@/lib/auth/totp";

/**
 * GET /api/auth/mfa/totp/status
 *
 * Check the current user's TOTP enrollment status and policy state.
 * Policy-independent — always accessible.
 */
export const GET = withAuth(
  async (_request, _context, session) => {
    const [credential, policy] = await Promise.all([
      getTotpCredential(session.accountId),
      loadMfaPolicy(),
    ]);

    return NextResponse.json({
      enrolled: credential?.verified === true,
      allowed: policy.allowedMethods.includes("totp"),
    });
  },
  { skipMfaEnrollCheck: true },
);
