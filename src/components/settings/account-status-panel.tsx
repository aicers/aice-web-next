"use client";

import { useTranslations } from "next-intl";

import { ActiveSessionsCard } from "../dashboard/active-sessions-card";
import { CertExpiryCard } from "../dashboard/cert-expiry-card";
import { LockedAccountsCard } from "../dashboard/locked-accounts-card";
import { SuspiciousAlertsCard } from "../dashboard/suspicious-alerts-card";

interface AccountStatusPanelProps {
  canWriteSessions: boolean;
  canWriteAccounts: boolean;
}

export function AccountStatusPanel({
  canWriteSessions,
  canWriteAccounts,
}: AccountStatusPanelProps) {
  const t = useTranslations("accountStatus");

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
