import { SettingsNav } from "@/components/layout/settings-nav";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
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
  // Visible whenever the session can navigate to triage (`triage:read`),
  // mirroring the menu-gate. Mutate buttons inside the page gate on
  // `triage:exclusion:write` / `triage:exclusion:global:write`
  // separately so a Security Monitor can navigate-to-view.
  const showTriageExclusions = session
    ? await hasPermission(session.roles, "triage:read")
    : false;
  const showAccountStatus = session
    ? await hasPermission(session.roles, "dashboard:read")
    : false;
  // Aimer integration is gated by role name, not permission, per #437.
  const showAimerIntegration = session
    ? isSystemAdministrator(session.roles)
    : false;

  return (
    <div className="space-y-6">
      <SettingsNav
        showAccounts={showAccounts}
        showRoles={showRoles}
        showCustomers={showCustomers}
        showPolicies={showPolicies}
        showTriageExclusions={showTriageExclusions}
        showAccountStatus={showAccountStatus}
        showAimerIntegration={showAimerIntegration}
      />
      {children}
    </div>
  );
}
