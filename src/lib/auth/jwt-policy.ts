import "server-only";

import { query } from "@/lib/db/client";

import { SettingsCache } from "./settings-cache";

// ── Types ────────────────────────────────────────────────────────

export interface JwtPolicy {
  accessTokenExpirationMinutes: number;
}

/** Shape of the `jwt_policy` JSONB value in the DB (snake_case). */
interface JwtPolicyRow {
  access_token_expiration_minutes: number;
}

// ── Defaults (matching migration 0007) ───────────────────────────

const DEFAULT_POLICY: JwtPolicy = {
  accessTokenExpirationMinutes: 15,
};

// ── Cache ────────────────────────────────────────────────────────

const cache = new SettingsCache<JwtPolicy>();
const CACHE_KEY = "jwt_policy";

export async function loadJwtPolicy(): Promise<JwtPolicy> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const base = { ...DEFAULT_POLICY };

  try {
    const result = await query<{ value: JwtPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["jwt_policy"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (typeof db.access_token_expiration_minutes === "number")
        base.accessTokenExpirationMinutes = db.access_token_expiration_minutes;
    }
  } catch {
    // DB unavailable — use defaults
  }

  cache.set(CACHE_KEY, base);
  return base;
}

/** Invalidate the cached policy so the next call re-queries the DB. */
export function invalidateJwtPolicy(): void {
  cache.invalidate(CACHE_KEY);
}
