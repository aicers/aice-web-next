import { Suspense } from "react";

import { TriagePolicyManager } from "@/components/triage/policy/triage-policy-manager";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function TriagePoliciesPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  // The page is gated by `triage:read` (the page-level read gate). The
  // mutation controls inside the manager are gated separately by
  // `triage:policy:write` so a read-only triage user does not see
  // affordances they would only be denied at submit time.
  await requirePermission(session, "triage:read");

  // Customer options come from the caller's effective triage scope —
  // NOT `/api/customers`, which requires `customers:read`. Threading
  // them through the server component lets a `triage:policy:write`
  // user without `customers:read` use this page.
  const scope = await getEffectiveCustomerScope(session);
  const canWritePolicy = await hasPermission(
    session.roles,
    "triage:policy:write",
  );

  return (
    <Suspense>
      <TriagePolicyManager
        customers={scope.customers}
        canWritePolicy={canWritePolicy}
      />
    </Suspense>
  );
}
