import "server-only";

import { query } from "@/lib/db/client";

/**
 * Mark a session as revoked in the database.
 */
export async function revokeSession(sid: string): Promise<void> {
  await query("UPDATE sessions SET revoked = true WHERE sid = $1", [sid]);
}
