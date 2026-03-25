"use client";

import { useTranslations } from "next-intl";

export function DashboardPanel() {
  const t = useTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("placeholder")}</p>
    </div>
  );
}
