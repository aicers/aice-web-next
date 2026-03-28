import "server-only";

import * as OTPAuth from "otpauth";

import { query } from "@/lib/db/client";

// ── Types ────────────────────────────────────────────────────────

interface TotpCredentialRow {
  id: string;
  account_id: string;
  secret: string;
  verified: boolean;
  created_at: Date;
}

export interface TotpCredential {
  id: string;
  accountId: string;
  secret: string;
  verified: boolean;
  createdAt: Date;
}

// ── Constants ────────────────────────────────────────────────────

const ISSUER = "AICE";
const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = "SHA1";

// ── TOTP helpers ─────────────────────────────────────────────────

/** Generate a 20-byte random secret encoded as base32. */
export function generateTotpSecret(): string {
  const secret = new OTPAuth.Secret({ size: 20 });
  return secret.base32;
}

/** Build an `otpauth://` URI for QR code rendering. */
export function buildTotpUri(secret: string, username: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.toString();
}

/**
 * Verify a TOTP code against the secret with ±1 step window.
 * Returns `true` if the code is valid.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

// ── DB helpers ───────────────────────────────────────────────────

function toCredential(row: TotpCredentialRow): TotpCredential {
  return {
    id: row.id,
    accountId: row.account_id,
    secret: row.secret,
    verified: row.verified,
    createdAt: row.created_at,
  };
}

/** Fetch a TOTP credential for the given account (verified or not). */
export async function getTotpCredential(
  accountId: string,
): Promise<TotpCredential | null> {
  const { rows } = await query<TotpCredentialRow>(
    "SELECT id, account_id, secret, verified, created_at FROM totp_credentials WHERE account_id = $1",
    [accountId],
  );
  return rows.length > 0 ? toCredential(rows[0]) : null;
}

/** Insert or replace an unverified TOTP credential. Returns true if stored. */
export async function enrollTotp(
  accountId: string,
  secret: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO totp_credentials (account_id, secret)
     VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE
       SET secret = EXCLUDED.secret, verified = false, created_at = NOW()
     WHERE totp_credentials.verified = false`,
    [accountId, secret],
  );
  return (rowCount ?? 0) > 0;
}

/** Set a specific credential to verified. Returns true if the row was found. */
export async function activateTotp(credentialId: string): Promise<boolean> {
  const { rowCount } = await query(
    "UPDATE totp_credentials SET verified = true WHERE id = $1 AND verified = false",
    [credentialId],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete the TOTP credential for the account. */
export async function removeTotp(accountId: string): Promise<void> {
  await query("DELETE FROM totp_credentials WHERE account_id = $1", [
    accountId,
  ]);
}
