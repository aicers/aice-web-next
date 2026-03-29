import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getWebAuthnCredentials } from "@/lib/auth/webauthn";

/**
 * GET /api/auth/mfa/webauthn/credentials
 *
 * List registered WebAuthn credentials for the current user.
 * Policy-independent — always accessible.
 */
export const GET = withAuth(async (_request, _context, session) => {
  const credentials = await getWebAuthnCredentials(session.accountId);

  return NextResponse.json({
    credentials: credentials.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      transports: c.transports,
    })),
  });
});
