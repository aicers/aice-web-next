import { Suspense } from "react";

import { RoleTable } from "@/components/roles/role-table";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function RolesPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "roles:read");

  const canWrite = await hasPermission(session.roles, "roles:write");
  const canDelete = await hasPermission(session.roles, "roles:delete");

  return (
    <Suspense>
      <RoleTable canWrite={canWrite} canDelete={canDelete} />
    </Suspense>
  );
}
