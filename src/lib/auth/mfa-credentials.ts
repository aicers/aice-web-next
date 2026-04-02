import "server-only";

import type pg from "pg";

/**
 * Delete all MFA credentials (TOTP, WebAuthn, recovery codes) and
 * revoke all active sessions for the given account.
 *
 * Must be called within an active transaction (`withTransaction`).
 */
export async function clearAllMfaCredentials(
  client: pg.PoolClient,
  accountId: string,
): Promise<void> {
  await client.query("DELETE FROM totp_credentials WHERE account_id = $1", [
    accountId,
  ]);
  await client.query("DELETE FROM webauthn_credentials WHERE account_id = $1", [
    accountId,
  ]);
  await client.query("DELETE FROM recovery_codes WHERE account_id = $1", [
    accountId,
  ]);
  await client.query(
    `UPDATE sessions SET revoked = true
     WHERE account_id = $1 AND revoked = false`,
    [accountId],
  );
}
