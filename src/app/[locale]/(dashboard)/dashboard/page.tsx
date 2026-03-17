import { DashboardPanel } from "@/components/dashboard/dashboard-panel";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  const canWriteSessions = await hasPermission(
    session.roles,
    "dashboard:write",
  );
  const canWriteAccounts = await hasPermission(session.roles, "accounts:write");

  return (
    <DashboardPanel
      canWriteSessions={canWriteSessions}
      canWriteAccounts={canWriteAccounts}
    />
  );
}
