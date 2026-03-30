import { NextResponse } from "next/server";

import { invalidateMfaPolicy } from "@/lib/auth/mfa-policy";
import { query } from "@/lib/db/client";

/**
 * POST /api/e2e/reset-mfa-policy
 *
 * Reset MFA policy to the default (both webauthn and totp allowed)
 * and invalidate the in-memory cache so the change takes effect
 * immediately.  Only available in non-production environments.
 */
export async function POST(): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await query(
    `UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = 'mfa_policy'`,
    [JSON.stringify({ allowed_methods: ["webauthn", "totp"] })],
  );
  invalidateMfaPolicy();

  return NextResponse.json({ ok: true });
}
