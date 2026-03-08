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
 * Resolve the effective customer IDs for a session.
 *
 * - If the session holds `customers:access-all`, returns `undefined`
 *   (meaning unrestricted access to all customers).
 * - Otherwise returns the array of assigned customer IDs.
 */
export async function resolveEffectiveCustomerIds(
  accountId: string,
  roles: string[],
): Promise<number[] | undefined> {
  const accessAll = await hasPermission(roles, "customers:access-all");
  if (accessAll) return undefined;
  return getAccountCustomerIds(accountId);
}
