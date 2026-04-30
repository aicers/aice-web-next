"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  type DetectionCustomerOption,
  DetectionUnauthorizedError,
  listCustomersForFilter,
} from "@/lib/detection";

export type FetchCustomersForFilterResult =
  | {
      ok: true;
      /**
       * Discriminator from `getEffectiveCustomerScope` — `'admin'` /
       * `'assigned'` / `'empty'`. The drawer renders the disabled
       * "No customer access" affordance for `'empty'`; the BFF
       * intersection check on the dispatch side is the authoritative
       * gate (see `validateFilterScope`).
       */
      kind: "admin" | "assigned" | "empty";
      customers: DetectionCustomerOption[];
    }
  | { ok: false; code: "unauthenticated" | "forbidden" | "server-error" };

/**
 * Client-callable wrapper around {@link listCustomersForFilter} for
 * the Detection filter drawer's Customer multi-select (#384).
 *
 * Mirrors the {@link fetchSensors} contract (#278) so the drawer
 * fetch + cache wiring is symmetrical between Customer and Sensor:
 * the server action returns a flat, serialisation-friendly shape
 * that the shell caches per page session and surfaces through the
 * shared loading / error / empty UI states.
 *
 * Authorization travels in the helper: callers without
 * `detection:read` are rejected with `forbidden`. An `'empty'`
 * scope is **not** an error — it is a valid sub-state the drawer
 * surfaces as "No customer access" with the trigger disabled.
 */
export async function fetchCustomersForFilter(): Promise<FetchCustomersForFilterResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const result = await listCustomersForFilter(session);
    return {
      ok: true,
      kind: result.kind,
      customers: result.customers,
    };
  } catch (err) {
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
