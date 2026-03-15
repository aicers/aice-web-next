import "server-only";

import { query } from "@/lib/db/client";

import { SettingsCache } from "./settings-cache";

// ── Types ────────────────────────────────────────────────────────

export type MfaMethod = "webauthn" | "totp";

export interface MfaPolicy {
  allowedMethods: MfaMethod[];
}

/** Shape of the `mfa_policy` JSONB value in the DB (snake_case). */
interface MfaPolicyRow {
  allowed_methods: string[];
}

// ── Defaults (matching migration 0007) ───────────────────────────

const DEFAULT_POLICY: MfaPolicy = {
  allowedMethods: ["webauthn", "totp"],
};

// ── Cache ────────────────────────────────────────────────────────

const cache = new SettingsCache<MfaPolicy>();
const CACHE_KEY = "mfa_policy";

export async function loadMfaPolicy(): Promise<MfaPolicy> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const base: MfaPolicy = {
    allowedMethods: [...DEFAULT_POLICY.allowedMethods],
  };

  try {
    const result = await query<{ value: MfaPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["mfa_policy"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (Array.isArray(db.allowed_methods)) {
        base.allowedMethods = db.allowed_methods.filter(
          (m): m is MfaMethod => m === "webauthn" || m === "totp",
        );
      }
    }
  } catch {
    // DB unavailable — use defaults
  }

  cache.set(CACHE_KEY, base);
  return base;
}

/** Invalidate the cached policy so the next call re-queries the DB. */
export function invalidateMfaPolicy(): void {
  cache.invalidate(CACHE_KEY);
}
