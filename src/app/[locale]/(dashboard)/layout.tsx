import { redirect } from "next/navigation";

import DashboardLayoutClient from "@/components/layout/dashboard-layout";
import { routing } from "@/i18n/routing";
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

  return (
    <DashboardLayoutClient username={username}>
      {children}
    </DashboardLayoutClient>
  );
}
