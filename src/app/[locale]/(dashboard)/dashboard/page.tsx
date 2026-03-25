import { DashboardPanel } from "@/components/dashboard/dashboard-panel";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  return <DashboardPanel />;
}
