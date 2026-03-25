import { SettingsNav } from "@/components/layout/settings-nav";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";

export default async function SettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();

  const showAccounts = session
    ? await hasPermission(session.roles, "accounts:read")
    : false;
  const showRoles = session
    ? await hasPermission(session.roles, "roles:read")
    : false;
  const showCustomers = session
    ? await hasPermission(session.roles, "customers:read")
    : false;
  const showPolicies = session
    ? await hasPermission(session.roles, "system-settings:read")
    : false;
  const showAccountStatus = session
    ? await hasPermission(session.roles, "dashboard:read")
    : false;

  return (
    <div className="space-y-6">
      <SettingsNav
        showAccounts={showAccounts}
        showRoles={showRoles}
        showCustomers={showCustomers}
        showPolicies={showPolicies}
        showAccountStatus={showAccountStatus}
      />
      {children}
    </div>
  );
}
