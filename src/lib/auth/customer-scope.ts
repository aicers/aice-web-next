import "server-only";

import { query } from "@/lib/db/client";

import { hasPermission } from "./permissions";

/**
 * Return all customer IDs assigned to the given account via
 * `account_customer`.  Returns an empty array if none.
 */
export async function getAccountCustomerIds(
  accountId: string,
): Promise<number[]> {
  const { rows } = await query<{ customer_id: number }>(
    "SELECT customer_id FROM account_customer WHERE account_id = $1 ORDER BY customer_id",
    [accountId],
  );
  return rows.map((r) => r.customer_id);
}

/**
 * Return every customer ID registered in `customers`, in ascending
 * order. Used to materialize the concrete scope for callers that hold
 * `customers:access-all`, so the Context JWT always carries an
 * explicit `customer_ids` list rather than relying on the consumer's
 * interpretation of an omitted claim.
 */
export async function getAllCustomerIds(): Promise<number[]> {
  const { rows } = await query<{ id: number }>(
    "SELECT id FROM customers ORDER BY id",
  );
  return rows.map((r) => r.id);
}

/**
 * Resolve the effective customer IDs for a session as an explicit
 * list.
 *
 * - If the session holds `customers:access-all`, returns every
 *   registered customer ID from `customers`. This materializes
 *   "unrestricted" scope into a concrete list so the Context JWT
 *   carries `customer_ids` explicitly for every caller — REview
 *   applies scoping from that claim set and does not re-derive it
 *   from role text.
 * - Otherwise returns the array of customer IDs assigned to the
 *   account via `account_customer` (possibly empty).
 */
export async function resolveEffectiveCustomerIds(
  accountId: string,
  roles: string[],
): Promise<number[]> {
  const accessAll = await hasPermission(roles, "customers:access-all");
  if (accessAll) return getAllCustomerIds();
  return getAccountCustomerIds(accountId);
}
