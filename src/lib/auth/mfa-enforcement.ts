import "server-only";

import { query } from "@/lib/db/client";

// ── Types ───────────────────────────────────────────────────────

export type MfaRequirement = "required" | "exempt" | "none";

// ── Enforcement logic ───────────────────────────────────────────

/**
 * Determine whether a user must have MFA enrolled.
 *
 * Priority: account-level override > role-level default.
 */
export function getMfaRequirement(
  mfaOverride: string | null,
  roleMfaRequired: boolean,
): MfaRequirement {
  if (mfaOverride === "exempt") return "exempt";
  if (mfaOverride === "required") return "required";
  if (roleMfaRequired) return "required";
  return "none";
}

/**
 * Check whether the account has at least one verified MFA method
 * (TOTP or WebAuthn).
 */
export async function isUserMfaEnrolled(accountId: string): Promise<boolean> {
  const { rows } = await query<{ enrolled: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM totp_credentials WHERE account_id = $1 AND verified = true
       UNION ALL
       SELECT 1 FROM webauthn_credentials WHERE account_id = $1
     ) AS enrolled`,
    [accountId],
  );
  return rows[0].enrolled;
}
