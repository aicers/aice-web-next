import { AccountStatusPanel } from "@/components/settings/account-status-panel";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function AccountStatusPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  const canWriteSessions = await hasPermission(
    session.roles,
    "dashboard:write",
  );
  const canWriteAccounts = await hasPermission(session.roles, "accounts:write");

  return (
    <AccountStatusPanel
      canWriteSessions={canWriteSessions}
      canWriteAccounts={canWriteAccounts}
    />
  );
}
