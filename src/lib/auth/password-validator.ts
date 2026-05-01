import "server-only";

import { query } from "@/lib/db/client";

import { verifyPassword } from "./password";
import { isBlocklisted } from "./password-blocklist";
import { loadPasswordPolicy } from "./password-policy";

// ── Types ────────────────────────────────────────────────────────

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Validator ────────────────────────────────────────────────────

/**
 * Validate a new password against the configured password policy.
 *
 * Checks (in order): length, complexity, blocklist, reuse history.
 * Returns all violations, not just the first.
 *
 * @param password    The plaintext new password.
 * @param accountId   Account UUID — used for reuse-ban lookup.
 * @param skipReuse   Skip the reuse ban check (for admin resets).
 */
export async function validatePassword(
  password: string,
  accountId: string,
  skipReuse = false,
): Promise<PasswordValidationResult> {
  const policy = await loadPasswordPolicy();
  const errors: string[] = [];

  // Length checks
  if (password.length < policy.minLength) {
    errors.push("TOO_SHORT");
  }
  if (password.length > policy.maxLength) {
    errors.push("TOO_LONG");
  }

  // Complexity checks (when enabled)
  if (policy.complexityEnabled) {
    if (!/[A-Z]/.test(password)) errors.push("MISSING_UPPERCASE");
    if (!/[a-z]/.test(password)) errors.push("MISSING_LOWERCASE");
    if (!/\d/.test(password)) errors.push("MISSING_DIGIT");
    if (!/[^A-Za-z0-9]/.test(password)) errors.push("MISSING_SPECIAL");
  }

  // Blocklist check
  if (isBlocklisted(password)) {
    errors.push("BLOCKLISTED");
  }

  // Reuse ban — skip if requested or if there are already errors
  // (no point hitting the DB for a password that fails other checks)
  if (!skipReuse && errors.length === 0 && policy.reuseBanCount > 0) {
    const { rows } = await query<{ password_hash: string }>(
      `SELECT password_hash FROM password_history
       WHERE account_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [accountId, policy.reuseBanCount],
    );

    for (const row of rows) {
      if (await verifyPassword(row.password_hash, password)) {
        errors.push("RECENTLY_USED");
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
