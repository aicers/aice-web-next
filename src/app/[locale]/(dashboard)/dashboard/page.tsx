import { DashboardPanel } from "@/components/dashboard/dashboard-panel";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  const canWrite = await hasPermission(session.roles, "dashboard:write");

  return <DashboardPanel canWrite={canWrite} />;
}
