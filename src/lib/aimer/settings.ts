import "server-only";

import { query } from "@/lib/db/client";

// ── Keys ────────────────────────────────────────────────────────

export const AIMER_SETTING_KEYS = ["aice_id", "aimer_web_bridge_url"] as const;
export type AimerSettingKey = (typeof AIMER_SETTING_KEYS)[number];

// Stored as JSONB in `system_settings`.  `null` is the unconfigured
// state; the row exists from the migration so updates always hit an
// existing row.
type StoredValue = { value: string | null };

// ── Validation ──────────────────────────────────────────────────

/**
 * RFC 1123 hostname.  Labels are 1–63 chars, alphanumerics with
 * internal hyphens, separated by dots.  Total length up to 253 chars.
 * Underscores are intentionally rejected — `aice_id` is also used as
 * the JWT `iss` claim and as the `trust_registry` lookup key on
 * aimer-web, so a strict hostname keeps the join key portable.
 */
const HOSTNAME_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/**
 * Maximum hostname length accepted by {@link validateAiceId}. Exported
 * so byte-budget reserves elsewhere (e.g. the Phase 2 payload-builder
 * augment reserve) carry through automatically if this limit ever
 * changes.
 */
export const AICE_ID_MAX_LENGTH = 253;

export function validateAiceId(value: string): {
  valid: boolean;
  error?: string;
} {
  if (typeof value !== "string" || value.length === 0) {
    return { valid: false, error: "aice_id must be a non-empty string" };
  }
  if (value.length > AICE_ID_MAX_LENGTH) {
    return {
      valid: false,
      error: `aice_id must be ${AICE_ID_MAX_LENGTH} characters or fewer`,
    };
  }
  const labels = value.split(".");
  if (labels.length === 0) {
    return { valid: false, error: "aice_id must be a hostname" };
  }
  for (const label of labels) {
    if (!HOSTNAME_LABEL.test(label)) {
      return {
        valid: false,
        error: `aice_id contains an invalid hostname label: ${label}`,
      };
    }
  }
  return { valid: true };
}

/**
 * HTTPS-only base URL, normalized to canonical form.  We accept any
 * URL whose protocol is `https:`, drop trailing slashes, and reject
 * inputs with credentials, fragments, or non-empty query strings —
 * those have no meaning on a base URL and would silently mis-route
 * the bridge POST.
 */
export function normalizeAimerWebBridgeUrl(input: string):
  | {
      ok: true;
      normalized: string;
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof input !== "string" || input.trim().length === 0) {
    return {
      ok: false,
      error: "aimer_web_bridge_url must be a non-empty string",
    };
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "aimer_web_bridge_url must be a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "aimer_web_bridge_url must use https:" };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      error: "aimer_web_bridge_url must not contain credentials",
    };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return {
      ok: false,
      error: "aimer_web_bridge_url must not contain a query string or fragment",
    };
  }
  // Strip trailing slashes from the pathname so `https://x.example/`
  // and `https://x.example` round-trip to the same canonical form.
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") pathname = "";
  const normalized = `${url.protocol}//${url.host}${pathname}`;
  return { ok: true, normalized };
}

// ── Read / write ────────────────────────────────────────────────

export async function getAimerIntegrationSettings(): Promise<{
  aiceId: string | null;
  bridgeUrl: string | null;
}> {
  const { rows } = await query<{ key: string; value: StoredValue }>(
    "SELECT key, value FROM system_settings WHERE key = ANY($1::text[])",
    [AIMER_SETTING_KEYS as readonly string[]],
  );

  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    aiceId: map.get("aice_id")?.value ?? null,
    bridgeUrl: map.get("aimer_web_bridge_url")?.value ?? null,
  };
}

/**
 * Update one Aimer integration setting.  Returns the prior value so
 * the caller can audit-log the before/after pair (the issue requires
 * the audit detail include `{key, old, new}`).
 */
export async function updateAimerIntegrationSetting(
  key: AimerSettingKey,
  rawValue: string,
): Promise<{
  valid: boolean;
  error?: string;
  oldValue?: string | null;
  newValue?: string;
}> {
  let normalized: string;
  if (key === "aice_id") {
    const validation = validateAiceId(rawValue);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }
    normalized = rawValue;
  } else {
    const result = normalizeAimerWebBridgeUrl(rawValue);
    if (!result.ok) {
      return { valid: false, error: result.error };
    }
    normalized = result.normalized;
  }

  const previous = await query<{ value: StoredValue }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [key],
  );
  const oldValue = previous.rows[0]?.value?.value ?? null;

  await query(
    "UPDATE system_settings SET value = $2, updated_at = NOW() WHERE key = $1",
    [key, JSON.stringify({ value: normalized } satisfies StoredValue)],
  );

  return { valid: true, oldValue, newValue: normalized };
}
