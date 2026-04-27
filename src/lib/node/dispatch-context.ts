import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";

import { NodePermissionError } from "./errors";

export const SYSTEM_ADMINISTRATOR = "System Administrator";

const CUSTOMERS_ACCESS_ALL = "customers:access-all";

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
 *
 * `hasGlobalScope` records whether the caller has the
 * `customers:access-all` permission and therefore has no tenant-scope
 * boundary at all. Callers that need to branch on "is this a
 * privileged / unscoped caller?" MUST consult this flag rather than
 * comparing the audit-only `role` string — `role` carries the first
 * role on the session for audit/log compatibility, but a multi-role
 * account or a custom role granting `customers:access-all` would not
 * surface as `"System Administrator"` there.
 */
export interface DispatchContext {
  role: string;
  customerIds: number[];
  hasGlobalScope: boolean;
}

/**
 * Build the dispatch context from an authenticated session, enforcing
 * the tenant-scope boundary before any GraphQL request reaches the
 * wire.
 *
 * - Callers with `customers:access-all` bypass the empty-scope check
 *   because global node operations (manager-only nodes, the cluster
 *   bootstrap case, an empty `customers` table at install time) are
 *   legitimately scoped to "no customer". For every other caller, an
 *   empty `customer_ids` is rejected with `NodePermissionError` —
 *   silently widening to "all customers" would indistinguishably
 *   degrade an under-provisioned tenant admin's view into the global
 *   view. The bypass is keyed off the effective permission, not the
 *   audit-only role string, so a custom role that carries
 *   `customers:access-all` (or a multi-role account whose first role
 *   is not `"System Administrator"`) is treated correctly.
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

  const hasGlobalScope = await hasPermission(
    session.roles,
    CUSTOMERS_ACCESS_ALL,
  );
  if (!hasGlobalScope && customerIds.length === 0) {
    throw new NodePermissionError(
      "Caller has no assigned customers; node management requires a customer scope.",
    );
  }

  return {
    role: session.roles[0] ?? "",
    customerIds,
    hasGlobalScope,
  };
}

/**
 * Assert that a node belonging to the given `customerId` is in scope
 * for the dispatch context. Callers with `customers:access-all` can
 * touch any node (their `hasGlobalScope` flag is true); every other
 * caller is restricted to the customers materialized in `customerIds`.
 *
 * The privileged bypass is keyed off the effective permission flag,
 * not the audit-only `role` string — a multi-role account where
 * `"System Administrator"` is not the first role, or a custom role
 * carrying `customers:access-all`, must still bypass scope here.
 *
 * Server actions that read or mutate a single node call this *after*
 * fetching the node's profile (which carries the `customerId`) so a
 * Tenant Administrator can never use a known-correct id to escalate
 * into another tenant's data. The check is a no-op for the empty
 * `customerIds` case because that is already rejected at
 * `buildDispatchContext` for callers without `customers:access-all`.
 */
export function assertNodeInScope(
  ctx: DispatchContext,
  nodeCustomerId: number,
): void {
  if (ctx.hasGlobalScope) return;
  if (ctx.customerIds.includes(nodeCustomerId)) return;
  throw new NodePermissionError(
    "Node belongs to a customer outside the caller's scope.",
  );
}
