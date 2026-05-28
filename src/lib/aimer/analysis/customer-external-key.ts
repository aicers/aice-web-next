import "server-only";

import { query } from "@/lib/db/client";

/**
 * Resolve a customer's `external_key` (the cross-system bridge
 * identifier paired with aimer-web) from the internal numeric
 * `customers.id`.
 *
 * `external_key` is the identifier aimer-web uses on its
 * customer-scoped read endpoints — `story_id` is not globally unique
 * across tenants, so the bridge URL embeds the resolved
 * `external_key`, never the internal integer id. This mirrors the
 * Phase 2 push path, where `customer_ids` on the context-token JWS is
 * the resolved `external_key`.
 *
 * Returns `null` when the row is missing or when `external_key` is
 * unset / blank; the AI-analysis route collapses that into the same
 * `204 No Content` surface as any other "render nothing" case.
 */
export async function resolveCustomerExternalKey(
  customerId: number,
): Promise<string | null> {
  const { rows } = await query<{ external_key: string | null }>(
    "SELECT external_key FROM customers WHERE id = $1",
    [customerId],
  );
  if (rows.length === 0) return null;
  const externalKey = rows[0].external_key?.trim() ?? "";
  return externalKey.length > 0 ? externalKey : null;
}
