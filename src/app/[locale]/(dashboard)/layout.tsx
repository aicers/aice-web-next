import { redirect } from "next/navigation";

import DashboardLayoutClient from "@/components/layout/dashboard-layout";
import { routing } from "@/i18n/routing";
import { getCurrentSession } from "@/lib/auth/session";

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

  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
