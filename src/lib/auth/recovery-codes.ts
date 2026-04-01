import "server-only";

import { randomBytes } from "node:crypto";

import argon2 from "argon2";

import { query, withTransaction } from "@/lib/db/client";

// ── Constants ───────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 4; // 4 bytes → 8 hex chars

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Generate a single recovery code in `A1B2-C3D4` format.
 */
function generateCode(): string {
  const hex = randomBytes(CODE_BYTES).toString("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/**
 * Normalize a user-entered code: strip dashes, uppercase.
 */
function normalizeCode(code: string): string {
  return code.replace(/-/g, "").toUpperCase();
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Generate 10 recovery codes, hash and store them, and return the
 * plaintext codes. Deletes any existing codes for the account.
 */
export async function generateRecoveryCodes(
  accountId: string,
): Promise<string[]> {
  const codes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    codes.push(generateCode());
  }
  const hashes = await Promise.all(
    codes.map((code) =>
      argon2.hash(normalizeCode(code), { type: argon2.argon2id }),
    ),
  );

  await withTransaction(async (client) => {
    await client.query("DELETE FROM recovery_codes WHERE account_id = $1", [
      accountId,
    ]);
    for (const hash of hashes) {
      await client.query(
        "INSERT INTO recovery_codes (account_id, code_hash) VALUES ($1, $2)",
        [accountId, hash],
      );
    }
  });

  return codes;
}

/**
 * Verify a recovery code and mark it as used if valid.
 * Returns `true` if the code was valid and consumed.
 */
export async function verifyRecoveryCode(
  accountId: string,
  code: string,
): Promise<boolean> {
  const normalized = normalizeCode(code);

  const { rows } = await query<{ id: string; code_hash: string }>(
    "SELECT id, code_hash FROM recovery_codes WHERE account_id = $1 AND used = false",
    [accountId],
  );

  for (const row of rows) {
    const valid = await argon2.verify(row.code_hash, normalized);
    if (valid) {
      await query(
        "UPDATE recovery_codes SET used = true, used_at = NOW() WHERE id = $1",
        [row.id],
      );
      return true;
    }
  }

  return false;
}

/**
 * Count remaining (unused) recovery codes for an account.
 */
export async function getRecoveryCodeCount(
  accountId: string,
): Promise<{ remaining: number; total: number }> {
  const { rows } = await query<{ remaining: string; total: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE used = false) AS remaining,
       COUNT(*) AS total
     FROM recovery_codes
     WHERE account_id = $1`,
    [accountId],
  );
  return {
    remaining: Number(rows[0].remaining),
    total: Number(rows[0].total),
  };
}
