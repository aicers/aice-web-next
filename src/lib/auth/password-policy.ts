import "server-only";

import { query } from "@/lib/db/client";

import { SettingsCache } from "./settings-cache";

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

const cache = new SettingsCache<PasswordPolicy>();
const CACHE_KEY = "password_policy";

export async function loadPasswordPolicy(): Promise<PasswordPolicy> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

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

  cache.set(CACHE_KEY, base);
  return base;
}

/** Invalidate the cached policy so the next call re-queries the DB. */
export function invalidatePasswordPolicy(): void {
  cache.invalidate(CACHE_KEY);
}

/** @deprecated Use `invalidatePasswordPolicy()` instead. Kept for test compatibility. */
export function resetPasswordPolicyCache(): void {
  cache.invalidate(CACHE_KEY);
}
