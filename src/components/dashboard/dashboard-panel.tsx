"use client";

import { useTranslations } from "next-intl";

import { ActiveSessionsCard } from "./active-sessions-card";
import { CertExpiryCard } from "./cert-expiry-card";
import { LockedAccountsCard } from "./locked-accounts-card";
import { SuspiciousAlertsCard } from "./suspicious-alerts-card";

interface DashboardPanelProps {
  canWriteSessions: boolean;
  canWriteAccounts: boolean;
}

export function DashboardPanel({
  canWriteSessions,
  canWriteAccounts,
}: DashboardPanelProps) {
  const t = useTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <ActiveSessionsCard canWrite={canWriteSessions} />
        <LockedAccountsCard canWrite={canWriteAccounts} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SuspiciousAlertsCard />
        <CertExpiryCard />
      </div>
    </div>
  );
}
