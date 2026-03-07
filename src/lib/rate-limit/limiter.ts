import "server-only";

import { query } from "@/lib/db/client";

import { InMemoryRateLimitStore } from "./store";

// ── Result type ──────────────────────────────────────────────────

export type RateLimitResult =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

// ── Config types ─────────────────────────────────────────────────

interface SignInRateLimitConfig {
  perIpCount: number;
  perIpWindowMinutes: number;
  perAccountIpCount: number;
  perAccountIpWindowMinutes: number;
  globalCount: number;
  globalWindowMinutes: number;
}

interface ApiRateLimitConfig {
  perUserCount: number;
  perUserWindowMinutes: number;
}

/** Shape of the `signin_rate_limit` JSONB value in the DB (snake_case). */
interface SignInRateLimitRow {
  per_ip_count: number;
  per_ip_window_minutes: number;
  per_account_ip_count: number;
  per_account_ip_window_minutes: number;
  global_count: number;
  global_window_minutes: number;
}

/** Shape of the `api_rate_limit` JSONB value in the DB (snake_case). */
interface ApiRateLimitRow {
  per_user_count: number;
  per_user_window_minutes: number;
}

// ── Defaults (matching migration 0007) ───────────────────────────

const DEFAULT_SIGNIN_CONFIG: SignInRateLimitConfig = {
  perIpCount: 20,
  perIpWindowMinutes: 5,
  perAccountIpCount: 5,
  perAccountIpWindowMinutes: 5,
  globalCount: 100,
  globalWindowMinutes: 1,
};

const DEFAULT_API_CONFIG: ApiRateLimitConfig = {
  perUserCount: 100,
  perUserWindowMinutes: 1,
};

// ── Config cache ─────────────────────────────────────────────────

let cachedSignInConfig: SignInRateLimitConfig | null = null;
let cachedApiConfig: ApiRateLimitConfig | null = null;

async function loadSignInConfig(): Promise<SignInRateLimitConfig> {
  if (cachedSignInConfig) return cachedSignInConfig;

  const base = { ...DEFAULT_SIGNIN_CONFIG };

  try {
    const result = await query<{ value: SignInRateLimitRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["signin_rate_limit"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (typeof db.per_ip_count === "number")
        base.perIpCount = db.per_ip_count;
      if (typeof db.per_ip_window_minutes === "number")
        base.perIpWindowMinutes = db.per_ip_window_minutes;
      if (typeof db.per_account_ip_count === "number")
        base.perAccountIpCount = db.per_account_ip_count;
      if (typeof db.per_account_ip_window_minutes === "number")
        base.perAccountIpWindowMinutes = db.per_account_ip_window_minutes;
      if (typeof db.global_count === "number")
        base.globalCount = db.global_count;
      if (typeof db.global_window_minutes === "number")
        base.globalWindowMinutes = db.global_window_minutes;
    }
  } catch {
    // DB unavailable — use defaults
  }

  cachedSignInConfig = base;
  return base;
}

async function loadApiConfig(): Promise<ApiRateLimitConfig> {
  if (cachedApiConfig) return cachedApiConfig;

  const base = { ...DEFAULT_API_CONFIG };

  try {
    const result = await query<{ value: ApiRateLimitRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["api_rate_limit"],
    );

    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      if (typeof db.per_user_count === "number")
        base.perUserCount = db.per_user_count;
      if (typeof db.per_user_window_minutes === "number")
        base.perUserWindowMinutes = db.per_user_window_minutes;
    }
  } catch {
    // DB unavailable — use defaults
  }

  cachedApiConfig = base;
  return base;
}

// ── Shared store singleton ───────────────────────────────────────

let store: InMemoryRateLimitStore | null = null;

function getStore(): InMemoryRateLimitStore {
  if (!store) {
    store = new InMemoryRateLimitStore();
  }
  return store;
}

// ── Helpers ──────────────────────────────────────────────────────

function retryAfter(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

// ── Sign-in rate limiting ────────────────────────────────────────

/**
 * Check three rate-limit buckets for sign-in attempts:
 *
 * 1. **Global** — protects against distributed brute-force
 * 2. **Per-IP** — limits attempts from a single source
 * 3. **Per-account+IP** — limits credential-stuffing per target
 *
 * @param ip       Client IP address (from X-Forwarded-For or socket)
 * @param username Optional — when absent, per-account+IP check is skipped.
 */
export async function checkSignInRateLimit(
  ip: string,
  username?: string,
): Promise<RateLimitResult> {
  const config = await loadSignInConfig();
  const s = getStore();

  // 1. Global
  const globalWindowMs = config.globalWindowMinutes * 60_000;
  const globalResult = s.increment("signin:global", globalWindowMs);
  if (globalResult.count > config.globalCount) {
    return {
      limited: true,
      retryAfterSeconds: retryAfter(globalResult.resetAt),
    };
  }

  // 2. Per-IP
  const ipWindowMs = config.perIpWindowMinutes * 60_000;
  const ipResult = s.increment(`signin:ip:${ip}`, ipWindowMs);
  if (ipResult.count > config.perIpCount) {
    return { limited: true, retryAfterSeconds: retryAfter(ipResult.resetAt) };
  }

  // 3. Per-account+IP (only when username is provided)
  if (username) {
    const accountIpWindowMs = config.perAccountIpWindowMinutes * 60_000;
    const accountIpResult = s.increment(
      `signin:account-ip:${username}:${ip}`,
      accountIpWindowMs,
    );
    if (accountIpResult.count > config.perAccountIpCount) {
      return {
        limited: true,
        retryAfterSeconds: retryAfter(accountIpResult.resetAt),
      };
    }
  }

  return { limited: false };
}

// ── API rate limiting ────────────────────────────────────────────

/**
 * Per-user rate limit for authenticated API requests.
 *
 * @param accountId The authenticated user's account ID.
 */
export async function checkApiRateLimit(
  accountId: string,
): Promise<RateLimitResult> {
  const config = await loadApiConfig();
  const s = getStore();

  const windowMs = config.perUserWindowMinutes * 60_000;
  const result = s.increment(`api:user:${accountId}`, windowMs);

  if (result.count > config.perUserCount) {
    return { limited: true, retryAfterSeconds: retryAfter(result.resetAt) };
  }

  return { limited: false };
}

// ── Sensitive-operation rate limiting ─────────────────────────────

const SENSITIVE_OP_COUNT = 5;
const SENSITIVE_OP_WINDOW_MINUTES = 15;

/**
 * Per-account rate limit for sensitive operations (password change, etc.).
 *
 * @param accountId The authenticated user's account ID.
 */
export async function checkSensitiveOpRateLimit(
  accountId: string,
): Promise<RateLimitResult> {
  const s = getStore();
  const windowMs = SENSITIVE_OP_WINDOW_MINUTES * 60_000;
  const result = s.increment(`sensitive:account:${accountId}`, windowMs);

  if (result.count > SENSITIVE_OP_COUNT) {
    return { limited: true, retryAfterSeconds: retryAfter(result.resetAt) };
  }

  return { limited: false };
}

// ── Test utilities ───────────────────────────────────────────────

/** Reset cached configs and destroy the store. For tests only. */
export function resetRateLimiter(): void {
  cachedSignInConfig = null;
  cachedApiConfig = null;
  if (store) {
    store.destroy();
    store = null;
  }
}
