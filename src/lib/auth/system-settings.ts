import "server-only";

import { query } from "@/lib/db/client";
import { invalidateRateLimitConfig } from "@/lib/rate-limit/limiter";

import { invalidateJwtPolicy } from "./jwt-policy";
import { invalidateLockoutPolicy } from "./lockout-policy";
import { invalidateMfaPolicy } from "./mfa-policy";
import { invalidatePasswordPolicy } from "./password-policy";
import { invalidateSessionPolicy } from "./session-policy";

// ── Types ───────────────────────────────────────────────────────

export interface SystemSettingRow {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface UpdateResult {
  valid: boolean;
  errors?: string[];
  data?: SystemSettingRow;
}

// ── Known setting keys ──────────────────────────────────────────

const KNOWN_KEYS = new Set([
  "password_policy",
  "session_policy",
  "lockout_policy",
  "jwt_policy",
  "mfa_policy",
  "signin_rate_limit",
  "api_rate_limit",
]);

// ── Cache invalidators ──────────────────────────────────────────

const CACHE_INVALIDATORS: Record<string, () => void> = {
  password_policy: invalidatePasswordPolicy,
  session_policy: invalidateSessionPolicy,
  lockout_policy: invalidateLockoutPolicy,
  jwt_policy: invalidateJwtPolicy,
  mfa_policy: invalidateMfaPolicy,
  signin_rate_limit: () => invalidateRateLimitConfig("signin_rate_limit"),
  api_rate_limit: () => invalidateRateLimitConfig("api_rate_limit"),
};

// ── Validators ──────────────────────────────────────────────────

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

const VALIDATORS: Record<string, (value: unknown) => ValidationResult> = {
  password_policy(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (!isInt(v.min_length) || v.min_length < 8 || v.min_length > 128)
      errors.push("min_length must be an integer between 8 and 128");
    if (
      !isInt(v.max_length) ||
      v.max_length < (isInt(v.min_length) ? v.min_length : 8) ||
      v.max_length > 256
    )
      errors.push("max_length must be an integer >= min_length and <= 256");
    if (typeof v.complexity_enabled !== "boolean")
      errors.push("complexity_enabled must be a boolean");
    if (
      !isInt(v.reuse_ban_count) ||
      v.reuse_ban_count < 0 ||
      v.reuse_ban_count > 24
    )
      errors.push("reuse_ban_count must be an integer between 0 and 24");
    return { valid: errors.length === 0, errors };
  },

  session_policy(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (
      !isInt(v.idle_timeout_minutes) ||
      v.idle_timeout_minutes < 1 ||
      v.idle_timeout_minutes > 1440
    )
      errors.push("idle_timeout_minutes must be an integer between 1 and 1440");
    if (
      !isInt(v.absolute_timeout_hours) ||
      v.absolute_timeout_hours < 1 ||
      v.absolute_timeout_hours > 720
    )
      errors.push(
        "absolute_timeout_hours must be an integer between 1 and 720",
      );
    if (
      v.max_sessions !== null &&
      (!isInt(v.max_sessions) || v.max_sessions < 1 || v.max_sessions > 100)
    )
      errors.push("max_sessions must be null or an integer between 1 and 100");
    return { valid: errors.length === 0, errors };
  },

  lockout_policy(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (
      !isInt(v.stage1_threshold) ||
      v.stage1_threshold < 1 ||
      v.stage1_threshold > 100
    )
      errors.push("stage1_threshold must be an integer between 1 and 100");
    if (
      !isInt(v.stage1_duration_minutes) ||
      v.stage1_duration_minutes < 1 ||
      v.stage1_duration_minutes > 1440
    )
      errors.push(
        "stage1_duration_minutes must be an integer between 1 and 1440",
      );
    return { valid: errors.length === 0, errors };
  },

  jwt_policy(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (
      !isInt(v.access_token_expiration_minutes) ||
      v.access_token_expiration_minutes < 1 ||
      v.access_token_expiration_minutes > 60
    )
      errors.push(
        "access_token_expiration_minutes must be an integer between 1 and 60",
      );
    return { valid: errors.length === 0, errors };
  },

  mfa_policy(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.allowed_methods) || v.allowed_methods.length === 0)
      errors.push("allowed_methods must be a non-empty array");
    else {
      const valid = new Set(["webauthn", "totp"]);
      for (const m of v.allowed_methods) {
        if (!valid.has(m as string))
          errors.push(`Invalid MFA method: ${String(m)}`);
      }
    }
    return { valid: errors.length === 0, errors };
  },

  signin_rate_limit(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (!isInt(v.per_ip_count) || v.per_ip_count < 1)
      errors.push("per_ip_count must be a positive integer");
    if (!isInt(v.per_ip_window_minutes) || v.per_ip_window_minutes < 1)
      errors.push("per_ip_window_minutes must be a positive integer");
    if (!isInt(v.per_account_ip_count) || v.per_account_ip_count < 1)
      errors.push("per_account_ip_count must be a positive integer");
    if (
      !isInt(v.per_account_ip_window_minutes) ||
      v.per_account_ip_window_minutes < 1
    )
      errors.push("per_account_ip_window_minutes must be a positive integer");
    if (!isInt(v.global_count) || v.global_count < 1)
      errors.push("global_count must be a positive integer");
    if (!isInt(v.global_window_minutes) || v.global_window_minutes < 1)
      errors.push("global_window_minutes must be a positive integer");
    return { valid: errors.length === 0, errors };
  },

  api_rate_limit(value) {
    const errors: string[] = [];
    const v = value as Record<string, unknown>;
    if (!isInt(v.per_user_count) || v.per_user_count < 1)
      errors.push("per_user_count must be a positive integer");
    if (!isInt(v.per_user_window_minutes) || v.per_user_window_minutes < 1)
      errors.push("per_user_window_minutes must be a positive integer");
    return { valid: errors.length === 0, errors };
  },
};

// ── Public API ──────────────────────────────────────────────────

/** Fetch all system settings. */
export async function getSystemSettings(): Promise<SystemSettingRow[]> {
  const result = await query<SystemSettingRow>(
    "SELECT key, value, updated_at FROM system_settings ORDER BY key",
  );
  return result.rows;
}

/** Fetch a single system setting by key. */
export async function getSystemSetting(
  key: string,
): Promise<SystemSettingRow | null> {
  const result = await query<SystemSettingRow>(
    "SELECT key, value, updated_at FROM system_settings WHERE key = $1",
    [key],
  );
  return result.rows[0] ?? null;
}

/** Validate a setting value against the known schema. */
export function validateSetting(key: string, value: unknown): ValidationResult {
  if (!KNOWN_KEYS.has(key)) {
    return { valid: false, errors: [`Unknown setting key: ${key}`] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["Value must be a JSON object"] };
  }
  return VALIDATORS[key](value);
}

/** Update a system setting with validation and cache invalidation. */
export async function updateSystemSetting(
  key: string,
  value: unknown,
): Promise<UpdateResult> {
  const validation = validateSetting(key, value);
  if (!validation.valid) {
    return validation;
  }

  const result = await query<SystemSettingRow>(
    "UPDATE system_settings SET value = $2, updated_at = NOW() WHERE key = $1 RETURNING key, value, updated_at",
    [key, JSON.stringify(value)],
  );

  if (result.rows.length === 0) {
    return { valid: false, errors: [`Setting not found: ${key}`] };
  }

  // Invalidate the relevant policy cache
  CACHE_INVALIDATORS[key]?.();

  return { valid: true, data: result.rows[0] };
}
