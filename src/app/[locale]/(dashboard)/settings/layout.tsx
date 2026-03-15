import { SettingsNav } from "@/components/layout/settings-nav";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";

export default async function SettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();
  const showSystem = session
    ? await hasPermission(session.roles, "system-settings:read")
    : false;

  return (
    <div className="space-y-6">
      <SettingsNav showSystem={showSystem} />
      {children}
    </div>
  );
}
