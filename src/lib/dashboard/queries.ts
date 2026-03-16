import "server-only";

import { query } from "@/lib/db/client";

// ── Types ────────────────────────────────────────────────────────

export interface ActiveSession {
  sid: string;
  account_id: string;
  username: string;
  display_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  browser_fingerprint: string | null;
  created_at: string;
  last_active_at: string;
  needs_reauth: boolean;
}

export interface LockedSuspendedAccount {
  id: string;
  username: string;
  display_name: string | null;
  role_name: string;
  status: string;
  locked_until: string | null;
  failed_sign_in_count: number;
  updated_at: string;
}

// ── Queries ──────────────────────────────────────────────────────

/**
 * Fetch all active (non-revoked) sessions with account info.
 */
export async function getActiveSessions(): Promise<ActiveSession[]> {
  const { rows } = await query<ActiveSession>(
    `SELECT s.sid, s.account_id, a.username,
            a.display_name, s.ip_address, s.user_agent,
            s.browser_fingerprint, s.created_at, s.last_active_at,
            s.needs_reauth
       FROM sessions s
       JOIN accounts a ON s.account_id = a.id
      WHERE s.revoked = false
      ORDER BY s.last_active_at DESC`,
  );
  return rows;
}

/**
 * Fetch accounts in `locked` or `suspended` status.
 */
export async function getLockedSuspendedAccounts(): Promise<
  LockedSuspendedAccount[]
> {
  const { rows } = await query<LockedSuspendedAccount>(
    `SELECT a.id, a.username, a.display_name, r.name AS role_name,
            a.status, a.locked_until, a.failed_sign_in_count, a.updated_at
       FROM accounts a
       JOIN roles r ON a.role_id = r.id
      WHERE a.status IN ('locked', 'suspended')
      ORDER BY a.updated_at DESC`,
  );
  return rows;
}
