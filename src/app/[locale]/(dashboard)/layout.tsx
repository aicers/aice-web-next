import { redirect } from "next/navigation";

import DashboardLayoutClient from "@/components/layout/dashboard-layout";
import { getCurrentSession } from "@/lib/auth/session";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();
  if (session?.mustChangePassword) {
    redirect("/change-password");
  }

  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
