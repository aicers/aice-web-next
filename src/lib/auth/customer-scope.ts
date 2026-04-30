import "server-only";

import { query } from "@/lib/db/client";

import type { AuthSession } from "./jwt";
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

// ── Effective scope (with names, for the UI indicator) ────────

/**
 * Customer summary surfaced by the indicator. Plain JSON-serializable
 * shape so the dashboard server layout can pass it as a prop into a
 * client component without any custom serialization.
 */
export interface CustomerScopeEntry {
  id: number;
  name: string;
}

/**
 * Effective customer scope for a session, formatted for display.
 *
 * - `kind: 'admin'` — the session holds `customers:access-all`. The
 *   scope is the entire registered customer set, but the indicator
 *   shows it as an admin-source badge rather than enumerating every
 *   customer name.
 * - `kind: 'assigned'` — the session is scoped via `account_customer`.
 *   `customers` holds those rows, possibly enumerating the entire
 *   customer set when the account happens to be assigned to all of
 *   them — that is *still* `'assigned'`, not `'admin'`.
 * - `kind: 'empty'` — no `account_customer` rows and no admin
 *   permission. Surfaced as a warning state.
 */
export interface EffectiveCustomerScope {
  kind: "admin" | "assigned" | "empty";
  customers: CustomerScopeEntry[];
}

/**
 * Resolve the customer scope of a session into a display-ready shape
 * for the UI indicator (issue #383). Wraps `hasPermission` and
 * `resolveEffectiveCustomerIds`, then JOINs against `customers` to
 * attach names.
 *
 * Admin and assignment are independent: a non-admin assigned to every
 * customer is `kind: 'assigned'`, not `'admin'`. The badge in the
 * indicator surfaces the *source* of the scope, which the operator
 * cannot otherwise tell from a name list alone.
 */
export async function getEffectiveCustomerScope(
  session: Pick<AuthSession, "accountId" | "roles">,
): Promise<EffectiveCustomerScope> {
  const isAdmin = await hasPermission(session.roles, "customers:access-all");
  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );

  if (ids.length === 0) {
    return { kind: isAdmin ? "admin" : "empty", customers: [] };
  }

  const { rows } = await query<{ id: number; name: string }>(
    "SELECT id, name FROM customers WHERE id = ANY($1::int[]) ORDER BY name",
    [ids],
  );

  return {
    kind: isAdmin ? "admin" : "assigned",
    customers: rows.map((r) => ({ id: r.id, name: r.name })),
  };
}
