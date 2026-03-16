"use client";

import { useTranslations } from "next-intl";

import { ActiveSessionsCard } from "./active-sessions-card";
import { LockedAccountsCard } from "./locked-accounts-card";
import { SuspiciousAlertsCard } from "./suspicious-alerts-card";

interface DashboardPanelProps {
  canWrite: boolean;
}

export function DashboardPanel({ canWrite }: DashboardPanelProps) {
  const t = useTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <ActiveSessionsCard canWrite={canWrite} />
        <LockedAccountsCard />
      </div>
      <SuspiciousAlertsCard />
    </div>
  );
}
