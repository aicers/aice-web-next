import { redirect } from "next/navigation";

import DashboardLayoutClient from "@/components/layout/dashboard-layout";
import { routing } from "@/i18n/routing";
import {
  type EffectiveCustomerScope,
  getEffectiveCustomerScope,
} from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";

export default async function DashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const session = await getCurrentSession();
  const localePrefix = locale === routing.defaultLocale ? "" : `/${locale}`;

  if (!session) {
    redirect(`${localePrefix}/sign-in`);
  }

  if (session?.mustChangePassword) {
    redirect(`${localePrefix}/change-password`);
  }

  if (session?.mustEnrollMfa) {
    redirect(`${localePrefix}/enroll-mfa`);
  }

  // Fetch username for sidebar display
  let username: string | undefined;
  try {
    const { rows } = await query<{ username: string }>(
      "SELECT username FROM accounts WHERE id = $1",
      [session.accountId],
    );
    username = rows[0]?.username;
  } catch {
    // DB unavailable — fall back to no username
  }

  // Resolve the session's effective customer scope so the indicator
  // and popover render server-side; the helper itself is server-only,
  // and the result is a plain JSON object that drops cleanly through
  // the client-component boundary.
  let scope: EffectiveCustomerScope = { kind: "empty", customers: [] };
  let canManageCustomers = false;
  try {
    scope = await getEffectiveCustomerScope(session);
    canManageCustomers = await hasPermission(session.roles, "customers:read");
  } catch {
    // DB unavailable — render the indicator's empty/warning state
    // rather than blocking the entire shell.
  }

  return (
    <DashboardLayoutClient
      username={username}
      scope={scope}
      canManageCustomers={canManageCustomers}
    >
      {children}
    </DashboardLayoutClient>
  );
}
