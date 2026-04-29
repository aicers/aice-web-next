import "server-only";

import { query } from "@/lib/db/client";

interface LastAppliedRow {
  last_applied_at: Date | null;
}

/**
 * Most recent moment a bulk-apply attempt finished successfully for the
 * given node, or `null` if no apply has ever succeeded. Drives the
 * "last applied at" field on the detail-page metadata card.
 *
 * Falls back from `succeeded_audit_completed_at` (audit insert
 * confirmed) to `succeeded_audit_emitted_at` (slot claimed) so the
 * field becomes visible as soon as the apply itself reaches
 * `status = 'succeeded'`, without waiting for the second half of the
 * two-step audit emission protocol to commit.
 */
export async function getLastAppliedAt(nodeId: string): Promise<Date | null> {
  const { rows } = await query<LastAppliedRow>(
    `SELECT MAX(COALESCE(succeeded_audit_completed_at,
                         succeeded_audit_emitted_at)) AS last_applied_at
       FROM apply_attempts
      WHERE node_id = $1
        AND status = 'succeeded'`,
    [nodeId],
  );
  if (rows.length === 0) return null;
  const value = rows[0].last_applied_at;
  return value ?? null;
}
