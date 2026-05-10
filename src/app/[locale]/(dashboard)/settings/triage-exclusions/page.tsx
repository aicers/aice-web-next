import { Suspense } from "react";

import { TriageExclusionManager } from "@/components/triage/exclusion/triage-exclusion-manager";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function TriageExclusionsPage() {
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

  return (
    <Suspense>
      <TriageExclusionManager
        scope="customer"
        customers={scope.customers}
        canMutate={canMutate}
      />
    </Suspense>
  );
}
