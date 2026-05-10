import { Suspense } from "react";

import { TriageExclusionManager } from "@/components/triage/exclusion/triage-exclusion-manager";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

interface PageProps {
  // Mirrors the existing query-parameter pattern used by other
  // customer-scoped settings pages — `?customer_id=42` deep-links to
  // a specific customer's exclusion list. Without this, the page
  // would silently fall back to the first customer in the caller's
  // scope, which is wrong for any operator with access to multiple
  // customers (#457 round 1 review).
  searchParams?: Promise<{ customer_id?: string }>;
}

export default async function TriageExclusionsPage({
  searchParams,
}: PageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  // Page-level read gate. Mutate buttons inside the page gate on
  // `triage:exclusion:write` so a Security Monitor can navigate to
  // view without being shown affordances they would only be denied
  // at submit time.
  await requirePermission(session, "triage:read");

  const scope = await getEffectiveCustomerScope(session);
  const canMutate = await hasPermission(
    session.roles,
    "triage:exclusion:write",
  );

  // Resolve the deep-linked customer to one inside the caller's
  // effective scope. An out-of-scope id falls through to `undefined`
  // (the manager picks the first available customer) rather than 403
  // — the URL is shareable across roles, so silently selecting the
  // closest legal default is the more useful behavior.
  const params = (await searchParams) ?? {};
  const requested = params.customer_id ? Number(params.customer_id) : NaN;
  const initialCustomerId =
    Number.isFinite(requested) &&
    Number.isInteger(requested) &&
    scope.customers.some((c) => c.id === requested)
      ? requested
      : undefined;

  return (
    <Suspense>
      <TriageExclusionManager
        scope="customer"
        customers={scope.customers}
        canMutate={canMutate}
        initialCustomerId={initialCustomerId}
      />
    </Suspense>
  );
}
