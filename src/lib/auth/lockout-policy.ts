import "server-only";

import { query } from "@/lib/db/client";

import { SettingsCache } from "./settings-cache";

// ── Types ────────────────────────────────────────────────────────

export interface LockoutPolicy {
  stage1Threshold: number;
  stage1DurationMinutes: number;
}

/** Shape of the `lockout_policy` JSONB value in the DB (snake_case). */
interface LockoutPolicyRow {
  stage1_threshold: number;
  stage1_duration_minutes: number;
}

// ── Defaults (matching migration 0007) ───────────────────────────

const DEFAULT_POLICY: LockoutPolicy = {
  stage1Threshold: 5,
  stage1DurationMinutes: 30,
};

// ── Cache ────────────────────────────────────────────────────────

const cache = new SettingsCache<LockoutPolicy>();
const CACHE_KEY = "lockout_policy";

export async function loadLockoutPolicy(): Promise<LockoutPolicy> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const base = { ...DEFAULT_POLICY };

  try {
    const result = await query<{ value: LockoutPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["lockout_policy"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (typeof db.stage1_threshold === "number")
        base.stage1Threshold = db.stage1_threshold;
      if (typeof db.stage1_duration_minutes === "number")
        base.stage1DurationMinutes = db.stage1_duration_minutes;
    }
  } catch {
    // DB unavailable — use defaults
  }

  cache.set(CACHE_KEY, base);
  return base;
}

/** Invalidate the cached policy so the next call re-queries the DB. */
export function invalidateLockoutPolicy(): void {
  cache.invalidate(CACHE_KEY);
}
