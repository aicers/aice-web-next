import "server-only";

import { createHash } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import {
  type AimerSigningKeyMaterial,
  loadActiveSigningKeyMaterial,
} from "./signing-key";

/**
 * Allowed values for the `lang` claim in {@link AnalyzeParamsTokenClaims}.
 * aimer-web's `verifyAnalyzeParamsToken` rejects any other value with
 * `lang_unsupported`.
 */
export type AnalyzeLang = "ENGLISH" | "KOREAN";

/**
 * Map a locale code from the aice-web-next UI to the upstream `lang`
 * claim accepted by aimer-web.
 *
 * Locales not in the curated mapping are treated as English so the
 * analyze flow stays operational on a new locale rollout (the LLM
 * answer can be re-rendered, the request itself stays valid).
 */
export function localeToAnalyzeLang(locale: string): AnalyzeLang {
  return locale.toLowerCase() === "ko" ? "KOREAN" : "ENGLISH";
}

/**
 * Claims embedded in the `analyze_params_token` JWS.
 *
 * The 9 fields below mirror the `verifyAnalyzeParamsToken` contract
 * documented in aicers/aimer-web#274. Three of them
 * (`context_jti`, `payload_hash`, `envelope_hash`) cross-bind this
 * token to the sibling `context_token` and `events_envelope` JWSes
 * so an attacker cannot swap one envelope for another without
 * invalidating the signature.
 */
export interface AnalyzeParamsTokenClaims {
  context_jti: string;
  payload_hash: string;
  envelope_hash: string;
  event_key: string;
  lang: AnalyzeLang;
  model_name: string;
  model: string;
  force: boolean;
  external_key: string;
}

/**
 * Sign an `analyze_params_token` using the active Aimer signing key.
 *
 * The JWS uses the same `kid` and `alg` (ES256) as the sibling
 * `events_envelope` JWS so aimer-web's verifier can locate the key
 * from a single trust-registry lookup.
 *
 * `iat` / `exp` are written by the caller so the token TTL stays
 * aligned with `context_token` / `events_envelope`.
 */
export async function signAnalyzeParamsToken(
  claims: AnalyzeParamsTokenClaims,
  options: {
    iss: string;
    iat: number;
    exp: number;
    /**
     * Pre-loaded signing key material. When omitted the helper loads
     * the active key itself — a convenience for test callers that do
     * not need cross-token kid pinning. The
     * envelope-mint route in `/api/aimer/analyze-envelope` always
     * passes this so its three sibling JWSes share one `kid`.
     */
    keyMaterial?: AimerSigningKeyMaterial;
  },
): Promise<string> {
  const keyMaterial = options.keyMaterial ?? loadActiveSigningKeyMaterial();
  if (!keyMaterial) {
    throw new Error(
      "No active Aimer signing key. Verify integration setup before signing.",
    );
  }
  const privateKey = await importJWK(
    keyMaterial.privateJwk,
    keyMaterial.algorithm,
  );

  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: keyMaterial.algorithm, kid: keyMaterial.kid })
    .setIssuer(options.iss)
    .setIssuedAt(options.iat)
    .setExpirationTime(options.exp)
    .sign(privateKey);
}

/**
 * Hash the compact-serialization bytes of an `events_envelope` JWS
 * into the `envelope_hash` claim of an {@link AnalyzeParamsTokenClaims}.
 * Used by aimer-web's cross-binding check to detect an envelope
 * swapped between sign and verify.
 */
export function eventsEnvelopeHash(eventsEnvelopeJws: string): string {
  return sha256Base64Url(Buffer.from(eventsEnvelopeJws, "utf8"));
}

/**
 * SHA-256 a byte buffer and emit the base64url (no padding) digest.
 * Shared between the `payload_hash` and `envelope_hash` cross-binding
 * claims so the two values are computed identically.
 */
export function sha256Base64Url(data: Uint8Array): string {
  return base64UrlEncode(createHash("sha256").update(data).digest());
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decimal i128 event-key pattern, matching the customer DB column
 * (`NUMERIC(39,0)`). aimer-web rejects mismatched keys with the
 * `event_key_mismatch` error code, so this gate runs before any
 * envelope is minted.
 */
export const ANALYZE_EVENT_KEY_PATTERN = /^[0-9]{1,39}$/;

/**
 * Top-level REview event fields the analyze-bridge `event_data`
 * canon explicitly does NOT carry. These are present on the REview
 * GraphQL selection set because the Detection UI renders them
 * (chips, badges, sort affordances), but aimer-web's `event_data`
 * contract is dispatched on `kind` plus the snake_case
 * baseline-column set — UI metadata leaks would only widen the
 * cross-origin payload surface without benefit.
 *
 * Keys are compared in snake_case form (post-{@link camelToSnake}).
 *
 * Kept separate from the alias table so renames and strips remain
 * easy to audit independently.
 */
const REVIEW_UI_ONLY_FIELDS: ReadonlySet<string> = new Set([
  // Common Event interface — UI-only fields.
  "id",
  "confidence",
  "level",
  "triage_scores",
  // Customer / network / country metadata — rendered as Detection
  // chips, never consumed by aimer-web.
  "orig_customer",
  "orig_customers",
  "resp_customer",
  "resp_customers",
  "orig_network",
  "resp_network",
  "orig_country",
  "orig_countries",
  "resp_country",
  "resp_countries",
]);

/**
 * Contract-specific renames applied at the top level of a REview
 * event row before it lands in the analyze-bridge `event_data`
 * canon. Compared in snake_case form (post-{@link camelToSnake}) so
 * the table reads as the on-wire mapping.
 *
 * - `time` → `event_time`: baseline rows expose `event_time`; REview
 *   exposes `time`. aimer-web's verifier reads `event_time`.
 * - `query` → `dns_query`: DNS subtypes (`BlocklistDns`,
 *   `DnsCovertChannel`) expose `query`; the baseline column is
 *   `dns_query` and aimer-web's verifier reads the same name.
 */
const REVIEW_KEY_ALIASES: Readonly<Record<string, string>> = {
  time: "event_time",
  query: "dns_query",
};

/**
 * Convert a single REview event payload (camelCase, with
 * `__typename` and UI affordances) into the snake-case canon
 * `event_data` shape the analyze-bridge endpoint consumes.
 *
 * Behaviour:
 *
 * - Drops the keys in {@link REVIEW_UI_ONLY_FIELDS} (UI / query-only
 *   affordances, plus nested customer / network metadata).
 * - Applies the renames in {@link REVIEW_KEY_ALIASES}
 *   (`time` → `event_time`, `query` → `dns_query`).
 * - Maps `__typename` to a top-level `kind` (snake) and drops the
 *   original camel key.
 * - Snake-cases every remaining key.
 * - Forces `event_key` to the caller-supplied locator value so
 *   `event_data.event_key` cannot drift from the
 *   `analyze_params_token.event_key` claim (aimer-web's
 *   `event_key_mismatch` guard).
 *
 * The output mirrors the baseline path's top-level field set as far
 * as REview exposes those fields: `event_key`, `event_time`, `kind`,
 * `sensor`, `orig_addr`, `orig_port`, `resp_addr`, `resp_port`,
 * `proto`, `host`, `dns_query`, `uri`, `category`. Per-subtype
 * fields beyond that set pass through snake-cased.
 */
export function eventToAnalyzeBridgeCanon(
  source: Record<string, unknown>,
  eventKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "__typename") {
      if (typeof value === "string") out.kind = value;
      continue;
    }
    const snake = camelToSnake(key);
    if (REVIEW_UI_ONLY_FIELDS.has(snake)) continue;
    const target = REVIEW_KEY_ALIASES[snake] ?? snake;
    out[target] = mapNestedValue(value);
  }
  out.event_key = eventKey;
  return out;
}

function mapNestedValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(mapNestedValue);
  if (typeof value === "object") {
    return mapNestedObject(value as Record<string, unknown>);
  }
  return value;
}

function mapNestedObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[camelToSnake(key)] = mapNestedValue(value);
  }
  return out;
}

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
