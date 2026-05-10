import { Suspense } from "react";

import { TriageExclusionManager } from "@/components/triage/exclusion/triage-exclusion-manager";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function GlobalTriageExclusionsPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  // Page is gated only on `triage:read` — a Security Monitor can
  // navigate to view what is in effect. The Add / Delete affordances
  // gate on `triage:exclusion:global:write` separately.
  await requirePermission(session, "triage:read");

  const canMutate = await hasPermission(
    session.roles,
    "triage:exclusion:global:write",
  );

  return (
    <Suspense>
      <TriageExclusionManager scope="global" canMutate={canMutate} />
    </Suspense>
  );
}
