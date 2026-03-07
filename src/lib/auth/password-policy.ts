import "server-only";

import { query } from "@/lib/db/client";

// ── Types ────────────────────────────────────────────────────────

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  complexityEnabled: boolean;
  reuseBanCount: number;
}

/** Shape of the `password_policy` JSONB value in the DB (snake_case). */
interface PasswordPolicyRow {
  min_length: number;
  max_length: number;
  complexity_enabled: boolean;
  reuse_ban_count: number;
}

// ── Defaults (matching migration 0007) ───────────────────────────

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  complexityEnabled: false,
  reuseBanCount: 5,
};

// ── Cache ────────────────────────────────────────────────────────

let cachedPolicy: PasswordPolicy | null = null;

export async function loadPasswordPolicy(): Promise<PasswordPolicy> {
  if (cachedPolicy) return cachedPolicy;

  const base = { ...DEFAULT_POLICY };

  try {
    const result = await query<{ value: PasswordPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["password_policy"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (typeof db.min_length === "number") base.minLength = db.min_length;
      if (typeof db.max_length === "number") base.maxLength = db.max_length;
      if (typeof db.complexity_enabled === "boolean")
        base.complexityEnabled = db.complexity_enabled;
      if (typeof db.reuse_ban_count === "number")
        base.reuseBanCount = db.reuse_ban_count;
    }
  } catch {
    // DB unavailable — use defaults
  }

  cachedPolicy = base;
  return base;
}

/** Reset cached policy. For tests only. */
export function resetPasswordPolicyCache(): void {
  cachedPolicy = null;
}
