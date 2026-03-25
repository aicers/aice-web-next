import { getTranslations } from "next-intl/server";

import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  const t = await getTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("placeholder")}</p>
    </div>
  );
}
