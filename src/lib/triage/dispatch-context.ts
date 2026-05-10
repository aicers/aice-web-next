import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";

import { TriageForbiddenError, TriageUnauthorizedError } from "./errors";

const TRIAGE_READ = "triage:read";
const CUSTOMERS_ACCESS_ALL = "customers:access-all";
const SYSTEM_ADMINISTRATOR = "System Administrator";

export interface TriageDispatchContext {
  role: string;
  /** Materialized customer scope; never empty when `hasGlobalScope` is false. */
  customerIds: number[];
  /** True when the caller holds `customers:access-all`. */
  hasGlobalScope: boolean;
}

/**
 * Verify `triage:read`, resolve the caller's customer scope, and
 * reject empty-scope non-admins before any REview round-trip. Shared
 * between {@link loadTriagePeriod} and the Tier 2 fetch surface so
 * Tier 2 inherits the same `triage:read` boundary — Tier 2 must NOT
 * implicitly require `detection:read` (#453 acceptance).
 */
export async function buildDispatchContext(
  session: AuthSession,
): Promise<TriageDispatchContext> {
  if (!(await hasPermission(session.roles, TRIAGE_READ))) {
    throw new TriageUnauthorizedError(
      "Caller lacks the triage:read permission.",
    );
  }
  const hasGlobalScope = await hasPermission(
    session.roles,
    CUSTOMERS_ACCESS_ALL,
  );
  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!hasGlobalScope && customerIds.length === 0) {
    throw new TriageForbiddenError(
      "Caller has no assigned customers; Triage requires a customer scope.",
    );
  }
  return { role: session.roles[0], customerIds, hasGlobalScope };
}

/**
 * Derive the Context JWT's `customer_ids` claim. Mirrors Detection's
 * `jwtCustomerIdsForDetection`: review's `validate_context_jwt`
 * accepts `customer_ids = None` only for `Role::SystemAdministrator`,
 * so the JWT omits the field for the bootstrap admin and ships the
 * materialized list for every other caller.
 */
export function jwtCustomerIdsForTriage(
  ctx: Pick<TriageDispatchContext, "role" | "customerIds">,
): number[] | undefined {
  return ctx.role === SYSTEM_ADMINISTRATOR ? undefined : ctx.customerIds;
}
