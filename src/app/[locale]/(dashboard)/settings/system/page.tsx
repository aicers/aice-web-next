import { SystemSettingsPanel } from "@/components/settings/system-settings-panel";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function SystemSettingsPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "system-settings:read");

  const canWrite = await hasPermission(session.roles, "system-settings:write");

  return <SystemSettingsPanel readOnly={!canWrite} />;
}
