import "server-only";

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { auditLog } from "@/lib/audit/logger";
import { getDataDir } from "@/lib/auth/data-dir";
import { clearAllMfaCredentials } from "@/lib/auth/mfa-credentials";
import { query, withTransaction } from "@/lib/db/client";

/**
 * Emergency MFA reset — break-glass mechanism for disaster recovery.
 *
 * Reads `process.env.EMERGENCY_MFA_RESET` as a username, then deletes
 * all MFA credentials and revokes all sessions for that account.
 *
 * A per-username marker file prevents re-execution on subsequent
 * restarts. The env var should be removed after use.
 */
export async function emergencyMfaReset(): Promise<void> {
  const username = process.env.EMERGENCY_MFA_RESET?.trim();
  if (!username) return;

  const dataDir = getDataDir();
  const markerPath = path.join(
    dataDir,
    `.emergency_mfa_reset_consumed_${username}`,
  );

  if (existsSync(markerPath)) {
    console.warn(
      `Emergency MFA reset already consumed for: ${username} (marker exists)`,
    );
    return;
  }

  // Find account
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM accounts WHERE username = $1",
    [username],
  );

  if (rows.length === 0) {
    console.warn(
      `⚠ Emergency MFA reset: account not found for username "${username}"`,
    );
    return;
  }

  const accountId = rows[0].id;

  // Delete all MFA credentials and revoke sessions
  await withTransaction(async (client) => {
    await clearAllMfaCredentials(client, accountId);
  });

  // Audit log
  await auditLog.record({
    actor: "system",
    action: "mfa.emergency.reset",
    target: "account",
    targetId: accountId,
    details: { username, reason: "emergency_break_glass" },
  });

  // Write marker file to prevent re-execution
  writeFileSync(markerPath, new Date().toISOString(), "utf-8");

  console.warn(`⚠ Emergency MFA reset completed for: ${username}`);
}
