import "server-only";

import { query } from "@/lib/db/client";

// ── Types ────────────────────────────────────────────────────────

interface WebAuthnCredentialRow {
  id: string;
  account_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  counter: string; // bigint comes as string from pg
  transports: string[] | null;
  display_name: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

export type AuthenticatorTransport = "usb" | "ble" | "nfc" | "internal";

export interface WebAuthnCredentialRecord {
  id: string;
  accountId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  displayName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface ChallengeRow {
  id: string;
  challenge: string;
}

// ── RP config ───────────────────────────────────────────────────

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

/** Resolve Relying Party configuration from environment variables. */
export function getRelyingParty(): RelyingParty {
  const DEFAULT_BASE_URL = "http://localhost:3000";
  // Vitest injects process.env.BASE_URL = "/" (viteConfig.base), so
  // validate that the value is an absolute URL before using it.
  let baseUrl = DEFAULT_BASE_URL;
  const raw = process.env.BASE_URL;
  if (raw) {
    try {
      new URL(raw);
      baseUrl = raw;
    } catch {
      // invalid or relative — fall back to default
    }
  }
  const url = new URL(baseUrl);

  return {
    id: process.env.WEBAUTHN_RP_ID ?? url.hostname,
    name: process.env.WEBAUTHN_RP_NAME ?? "AICE",
    origin: process.env.WEBAUTHN_RP_ORIGIN ?? baseUrl,
  };
}

// ── Row conversion ──────────────────────────────────────────────

function toCredential(row: WebAuthnCredentialRow): WebAuthnCredentialRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    credentialId: Uint8Array.from(row.credential_id),
    publicKey: Uint8Array.from(row.public_key),
    counter: Number(row.counter),
    transports: row.transports,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// ── Credential DB helpers ───────────────────────────────────────

/** Fetch all WebAuthn credentials for the given account. */
export async function getWebAuthnCredentials(
  accountId: string,
): Promise<WebAuthnCredentialRecord[]> {
  const { rows } = await query<WebAuthnCredentialRow>(
    `SELECT id, account_id, credential_id, public_key, counter,
            transports, display_name, created_at, last_used_at
     FROM webauthn_credentials
     WHERE account_id = $1
     ORDER BY created_at ASC`,
    [accountId],
  );
  return rows.map(toCredential);
}

/** Fetch a single WebAuthn credential by its credential_id (binary). */
export async function getWebAuthnCredentialByCredentialId(
  credentialId: Uint8Array,
): Promise<WebAuthnCredentialRecord | null> {
  const { rows } = await query<WebAuthnCredentialRow>(
    `SELECT id, account_id, credential_id, public_key, counter,
            transports, display_name, created_at, last_used_at
     FROM webauthn_credentials
     WHERE credential_id = $1`,
    [Buffer.from(credentialId)],
  );
  return rows.length > 0 ? toCredential(rows[0]) : null;
}

/** Fetch a single WebAuthn credential by its UUID (primary key). */
export async function getWebAuthnCredentialById(
  id: string,
  accountId: string,
): Promise<WebAuthnCredentialRecord | null> {
  const { rows } = await query<WebAuthnCredentialRow>(
    `SELECT id, account_id, credential_id, public_key, counter,
            transports, display_name, created_at, last_used_at
     FROM webauthn_credentials
     WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  return rows.length > 0 ? toCredential(rows[0]) : null;
}

/** Store a new WebAuthn credential. */
export async function storeWebAuthnCredential(params: {
  accountId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
  displayName?: string;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO webauthn_credentials
       (account_id, credential_id, public_key, counter, transports, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      params.accountId,
      Buffer.from(params.credentialId),
      Buffer.from(params.publicKey),
      params.counter,
      params.transports ?? null,
      params.displayName ?? null,
    ],
  );
  return rows[0].id;
}

/** Update the signature counter after a successful authentication. */
export async function updateWebAuthnCounter(
  credentialId: Uint8Array,
  counter: number,
): Promise<void> {
  await query(
    "UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2",
    [counter, Buffer.from(credentialId)],
  );
}

/** Rename a credential's display name. */
export async function updateWebAuthnDisplayName(
  id: string,
  accountId: string,
  displayName: string,
): Promise<boolean> {
  const { rowCount } = await query(
    "UPDATE webauthn_credentials SET display_name = $1 WHERE id = $2 AND account_id = $3",
    [displayName, id, accountId],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete a single WebAuthn credential (ownership verified via accountId). */
export async function removeWebAuthnCredential(
  id: string,
  accountId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM webauthn_credentials WHERE id = $1 AND account_id = $2",
    [id, accountId],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete all WebAuthn credentials for an account. */
export async function removeAllWebAuthnCredentials(
  accountId: string,
): Promise<void> {
  await query("DELETE FROM webauthn_credentials WHERE account_id = $1", [
    accountId,
  ]);
}

// ── Encoding helpers ────────────────────────────────────────────

/** Convert a Uint8Array to a base64url-encoded string. */
export function bufferToBase64url(buf: Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a base64url-encoded string to a Uint8Array. */
export function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

// ── Challenge DB helpers ────────────────────────────────────────

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

/** Store a registration challenge (one per account, UPSERT). */
export async function storeRegistrationChallenge(
  accountId: string,
  challenge: string,
): Promise<string> {
  // Clean up expired challenges first
  await query(
    "DELETE FROM webauthn_registration_challenges WHERE expires_at < NOW()",
  );

  const { rows } = await query<{ id: string }>(
    `INSERT INTO webauthn_registration_challenges (account_id, challenge, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${CHALLENGE_TTL_SECONDS} seconds')
     ON CONFLICT (account_id) DO UPDATE
       SET challenge = EXCLUDED.challenge,
           expires_at = EXCLUDED.expires_at
     RETURNING id`,
    [accountId, challenge],
  );
  return rows[0].id;
}

/** Retrieve and consume a registration challenge. Returns null if expired or not found. */
export async function consumeRegistrationChallenge(
  accountId: string,
): Promise<string | null> {
  const { rows } = await query<ChallengeRow>(
    `DELETE FROM webauthn_registration_challenges
     WHERE account_id = $1 AND expires_at > NOW()
     RETURNING id, challenge`,
    [accountId],
  );
  return rows.length > 0 ? rows[0].challenge : null;
}

/** Store an authentication challenge keyed by login attempt (jti). */
export async function storeAuthenticationChallenge(
  accountId: string,
  jti: string,
  challenge: string,
): Promise<string> {
  await query(
    "DELETE FROM webauthn_authentication_challenges WHERE expires_at < NOW()",
  );

  const { rows } = await query<{ id: string }>(
    `INSERT INTO webauthn_authentication_challenges (account_id, jti, challenge, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${CHALLENGE_TTL_SECONDS} seconds')
     ON CONFLICT (jti) DO UPDATE
       SET challenge = EXCLUDED.challenge,
           expires_at = EXCLUDED.expires_at
     RETURNING id`,
    [accountId, jti, challenge],
  );
  return rows[0].id;
}

/** Retrieve and consume an authentication challenge by login attempt (jti). Returns null if expired or not found. */
export async function consumeAuthenticationChallenge(
  jti: string,
): Promise<string | null> {
  const { rows } = await query<ChallengeRow>(
    `DELETE FROM webauthn_authentication_challenges
     WHERE jti = $1 AND expires_at > NOW()
     RETURNING id, challenge`,
    [jti],
  );
  return rows.length > 0 ? rows[0].challenge : null;
}
