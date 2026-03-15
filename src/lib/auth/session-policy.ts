import "server-only";

import { query } from "@/lib/db/client";

import { SettingsCache } from "./settings-cache";

// ── Types ───────────────────────────────────────────────────────

export interface SessionPolicy {
  idleTimeoutMinutes: number;
  absoluteTimeoutHours: number;
  maxSessions: number | null;
}

interface SessionPolicyRow {
  idle_timeout_minutes?: number;
  absolute_timeout_hours?: number;
  max_sessions?: number | null;
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULTS: SessionPolicy = {
  idleTimeoutMinutes: 30,
  absoluteTimeoutHours: 8,
  maxSessions: null,
};

// ── Cache ────────────────────────────────────────────────────────

const cache = new SettingsCache<SessionPolicy>();
const CACHE_KEY = "session_policy";

// ── Public API ──────────────────────────────────────────────────

/**
 * Load session policy with priority: env vars > DB > defaults.
 *
 * Results are cached for 60 seconds so that hot paths like
 * `withAuth()` do not query the database on every request.
 *
 * Environment variables:
 *   SESSION_IDLE_TIMEOUT_MINUTES
 *   SESSION_ABSOLUTE_TIMEOUT_HOURS
 *   SESSION_MAX_SESSIONS
 */
export async function loadSessionPolicy(): Promise<SessionPolicy> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  // Start with defaults
  const policy: SessionPolicy = { ...DEFAULTS };

  // Override with DB values
  try {
    const result = await query<{ value: SessionPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["session_policy"],
    );
    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (db.idle_timeout_minutes !== undefined) {
        policy.idleTimeoutMinutes = db.idle_timeout_minutes;
      }
      if (db.absolute_timeout_hours !== undefined) {
        policy.absoluteTimeoutHours = db.absolute_timeout_hours;
      }
      if (db.max_sessions !== undefined) {
        policy.maxSessions = db.max_sessions;
      }
    }
  } catch {
    // DB unavailable — use defaults
  }

  // Override with env vars (highest priority)
  const envIdle = process.env.SESSION_IDLE_TIMEOUT_MINUTES;
  if (envIdle) {
    const parsed = Number(envIdle);
    if (!Number.isNaN(parsed) && parsed > 0) {
      policy.idleTimeoutMinutes = parsed;
    }
  }

  const envAbsolute = process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS;
  if (envAbsolute) {
    const parsed = Number(envAbsolute);
    if (!Number.isNaN(parsed) && parsed > 0) {
      policy.absoluteTimeoutHours = parsed;
    }
  }

  const envMaxSessions = process.env.SESSION_MAX_SESSIONS;
  if (envMaxSessions) {
    const parsed = Number(envMaxSessions);
    if (!Number.isNaN(parsed) && parsed > 0) {
      policy.maxSessions = parsed;
    }
  }

  cache.set(CACHE_KEY, policy);
  return policy;
}

/** Invalidate the cached policy so the next call re-queries the DB. */
export function invalidateSessionPolicy(): void {
  cache.invalidate(CACHE_KEY);
}

/**
 * Check if a session has exceeded the idle timeout.
 */
export function isIdleTimedOut(
  lastActiveAt: Date,
  idleTimeoutMinutes: number,
): boolean {
  const now = Date.now();
  const elapsed = now - lastActiveAt.getTime();
  return elapsed > idleTimeoutMinutes * 60 * 1000;
}

/**
 * Check if a session has exceeded the absolute timeout.
 */
export function isAbsoluteTimedOut(
  createdAt: Date,
  absoluteTimeoutHours: number,
): boolean {
  const now = Date.now();
  const elapsed = now - createdAt.getTime();
  return elapsed > absoluteTimeoutHours * 60 * 60 * 1000;
}
