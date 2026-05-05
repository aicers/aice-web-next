import "server-only";

import { query } from "@/lib/db/client";

/**
 * Per-customer eligibility for the Send to Aimer flow (Sub-7.2.E /
 * #440): a customer is "bridge-eligible" when its `external_key`
 * column (#438) is non-NULL and non-empty after `trim()`.
 *
 * The boolean is what the client component receives via props.  The
 * raw `external_key` string never crosses the server / client
 * boundary on this page — the issuance endpoint (#439) re-reads it
 * server-side at click time.
 */
export async function getCustomerBridgeEligibility(
  customerIds: readonly number[],
): Promise<Record<number, boolean>> {
  const out: Record<number, boolean> = {};
  for (const id of customerIds) out[id] = false;
  if (customerIds.length === 0) return out;

  const { rows } = await query<{ id: number; external_key: string | null }>(
    "SELECT id, external_key FROM customers WHERE id = ANY($1::int[])",
    [customerIds],
  );
  for (const row of rows) {
    out[row.id] = (row.external_key?.trim() ?? "").length > 0;
  }
  return out;
}
