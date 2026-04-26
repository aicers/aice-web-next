import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";

import { NodePermissionError } from "./errors";

export const SYSTEM_ADMINISTRATOR = "System Administrator";

/**
 * The materialized tenant scope for a single Node-management dispatch.
 *
 * Every Node server action calls {@link buildDispatchContext} as its
 * first step and threads the result through every downstream call —
 * including the per-service read abstraction in `service-dispatch.ts`.
 * This is the seam at which tenant scope is enforced for the Node
 * layer; once the context is built, callers must not re-derive scope
 * from anywhere else.
 *
 * `customerIds` is always an explicit list, even for callers with
 * `customers:access-all`. The Context JWT carries it verbatim so
 * review-web does not have to re-derive scope from role text — see
 * the symmetric Detection comment in `lib/detection/server-actions.ts`.
 */
export interface DispatchContext {
  role: string;
  customerIds: number[];
}

/**
 * Build the dispatch context from an authenticated session, enforcing
 * the tenant-scope boundary before any GraphQL request reaches the
 * wire.
 *
 * - System Administrators bypass the empty-scope check because
 *   global node operations (manager-only nodes, the cluster bootstrap
 *   case) are legitimately scoped to "no customer". For every other
 *   role, an empty `customer_ids` is rejected with
 *   `NodePermissionError` — silently widening to "all customers"
 *   would indistinguishably degrade an under-provisioned tenant
 *   admin's view into the global view.
 *
 * - Permission checks (`nodes:read`, `nodes:write`, `nodes:delete`,
 *   `services:read`, `services:write`) are not performed here because
 *   they vary per-action. Each server action calls `hasPermission`
 *   for the verb it is about to execute, *and then* calls this
 *   helper to materialize the tenant scope. Both checks must pass
 *   before the GraphQL client is invoked.
 *
 * The role string carried in the context is the first role on the
 * session, matching the Detection convention. review-web does not
 * inspect role text for scoping (it reads `customer_ids` from the
 * Context JWT) but does use it for audit logging.
 */
export async function buildDispatchContext(
  session: AuthSession,
): Promise<DispatchContext> {
  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );

  const isSystemAdmin = session.roles.includes(SYSTEM_ADMINISTRATOR);
  if (!isSystemAdmin && customerIds.length === 0) {
    throw new NodePermissionError(
      "Caller has no assigned customers; node management requires a customer scope.",
    );
  }

  return {
    role: session.roles[0] ?? "",
    customerIds,
  };
}

/**
 * Assert that a node belonging to the given `customerId` is in scope
 * for the dispatch context. System Administrators can touch any node;
 * every other caller is restricted to the customers materialized in
 * `customerIds`.
 *
 * Server actions that read or mutate a single node call this *after*
 * fetching the node's profile (which carries the `customerId`) so a
 * Tenant Administrator can never use a known-correct id to escalate
 * into another tenant's data. The check is a no-op for the empty
 * `customerIds` case because that is already rejected at
 * `buildDispatchContext` for non-System-Administrator callers.
 */
export function assertNodeInScope(
  ctx: DispatchContext,
  nodeCustomerId: number,
): void {
  if (ctx.role === SYSTEM_ADMINISTRATOR) return;
  if (ctx.customerIds.includes(nodeCustomerId)) return;
  throw new NodePermissionError(
    "Node belongs to a customer outside the caller's scope.",
  );
}
