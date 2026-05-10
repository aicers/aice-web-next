import "server-only";

import { createHash } from "node:crypto";

/**
 * Stable hash of `(accountId, sorted(customerIds))` used as a cache
 * scope key by client-side caches that hold customer-private data.
 *
 * The value is opaque to callers — it never leaves the browser and is
 * only used for equality, so any collision-resistant-enough hash is
 * fine. We use SHA-256 of the canonical string
 * `accountId + ':' + customerIds.sort().join(',')` so a no-op
 * `customer.assign` / `customer.unassign` round-trip yields the same
 * fingerprint and a real change yields a different one.
 *
 * Used by:
 * - `src/lib/detection/tabs-storage.ts` to namespace the
 *   `detection:tabs:v1` `sessionStorage` payload by scope, so a
 *   sign-out / sign-in or scope swap in the same browser tab cannot
 *   surface another scope's saved tab UX state.
 * - `src/components/detection/detection-analytics.tsx` to key the
 *   in-memory analytics result cache by scope, so a same-account
 *   customer-assignment change invalidates the cache.
 *
 * Companion to the `token_version` bump in
 * `POST /api/accounts/[id]/customers` and
 * `DELETE /api/accounts/[id]/customers/[customerId]`: the bump pushes
 * the session into a 401 → forced re-auth path on the *next* request,
 * and this fingerprint guards client-side caches that might otherwise
 * paint stale customer data before the next request runs.
 */
export function computeScopeFingerprint(
  accountId: string,
  customerIds: readonly number[],
): string {
  const sorted = [...customerIds].sort((a, b) => a - b).join(",");
  const canonical = `${accountId}:${sorted}`;
  return createHash("sha256").update(canonical).digest("hex");
}
