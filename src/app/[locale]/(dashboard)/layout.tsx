import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import DashboardLayoutClient from "@/components/layout/dashboard-layout";
import { routing } from "@/i18n/routing";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
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
  // the client-component boundary. We deliberately do NOT swallow
  // failures here: an unavailable DB / permission lookup is a real
  // error and `empty` carries the specific meaning "no customer
  // access," not "we could not figure out scope." Letting the error
  // propagate keeps the indicator state honest (the next/error
  // boundary surfaces the actual fault) and matches the pages below
  // that call `getEffectiveCustomerScope()` again without their own
  // catch.
  const scope = await getEffectiveCustomerScope(session);
  const canManageCustomers = await hasPermission(
    session.roles,
    "customers:read",
  );

  // Read the persisted sidebar preference so the first server-rendered
  // HTML matches the user's choice — avoids the expanded-then-collapsed
  // flash on reload. Cookie is authoritative; a missing cookie means
  // "no preference yet," not "expanded."
  const sidebarCookie = (await cookies()).get("sidebar-collapsed");
  const hasSidebarCollapsedCookie = sidebarCookie !== undefined;
  const initialSidebarCollapsed = sidebarCookie?.value === "true";

  return (
    <DashboardLayoutClient
      username={username}
      scope={scope}
      canManageCustomers={canManageCustomers}
      initialSidebarCollapsed={initialSidebarCollapsed}
      hasSidebarCollapsedCookie={hasSidebarCollapsedCookie}
    >
      {children}
    </DashboardLayoutClient>
  );
}
