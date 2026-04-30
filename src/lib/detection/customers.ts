import "server-only";

import {
  type CustomerScopeEntry,
  type EffectiveCustomerScope,
  getEffectiveCustomerScope,
} from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";

import { DetectionUnauthorizedError } from "./errors";

const DETECTION_READ = "detection:read";

/**
 * A customer entry for the Detection filter drawer's Customer
 * multi-select. Keeps the helper's `{id, name}` shape — `id` is the
 * numeric `customers.id`, suitable for the drawer's `number[]` draft
 * state. The drawer converts to the wire-compatible `string[]`
 * representation at the apply boundary.
 */
export interface DetectionCustomerOption {
  id: number;
  name: string;
}

/**
 * Result returned by {@link listCustomersForFilter}.
 *
 * Mirrors {@link EffectiveCustomerScope}'s discriminator so consumers
 * can distinguish `'admin'` (full customer set, surfaced in the
 * drawer the same way as a maxed-out assignment), `'assigned'`
 * (account-scoped subset), and `'empty'` (no customer access — the
 * drawer disables the control and never submits a `customers`
 * filter). The `customers` array is always present so callers can
 * iterate without branching, with the empty array signalling the
 * `'empty'` state.
 */
export interface DetectionCustomerListResult {
  kind: EffectiveCustomerScope["kind"];
  customers: DetectionCustomerOption[];
}

/**
 * Return the customer options visible to the caller for the
 * Detection filter drawer. Wraps {@link getEffectiveCustomerScope}
 * — the same helper that drives the page-header customer scope
 * indicator (#383) — so the drawer and indicator can never disagree
 * about which customers are in scope.
 *
 * Authorization mirrors `searchEvents` and `listSensors`: the caller
 * must hold `detection:read`, otherwise a {@link
 * DetectionUnauthorizedError} is thrown before any DB read. An empty
 * customer scope is **not** rejected here — the drawer renders a
 * disabled "No customer access" affordance for the `'empty'` kind,
 * and the server-side intersection check on the filter dispatch path
 * gates any actual REview call. Letting `listCustomersForFilter`
 * succeed with `kind: 'empty'` keeps the drawer's loading-vs-empty
 * UI distinguishable.
 */
export async function listCustomersForFilter(
  session: AuthSession,
): Promise<DetectionCustomerListResult> {
  if (!(await hasPermission(session.roles, DETECTION_READ))) {
    throw new DetectionUnauthorizedError(
      "Caller lacks the detection:read permission.",
    );
  }
  const scope = await getEffectiveCustomerScope(session);
  return {
    kind: scope.kind,
    customers: scope.customers.map(
      (c: CustomerScopeEntry): DetectionCustomerOption => ({
        id: c.id,
        name: c.name,
      }),
    ),
  };
}
