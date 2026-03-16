"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ── Types ────────────────────────────────────────────────────────

type CertSeverity = "ok" | "warning" | "critical";

interface CertStatus {
  configured: boolean;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  severity?: CertSeverity;
}

// ── Badge variant mapping ────────────────────────────────────────

const SEVERITY_VARIANT: Record<
  CertSeverity,
  "default" | "secondary" | "destructive"
> = {
  ok: "secondary",
  warning: "default",
  critical: "destructive",
};

// ── Component ────────────────────────────────────────────────────

export function CertExpiryCard() {
  const t = useTranslations("dashboard.certExpiry");

  const [status, setStatus] = useState<CertStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/cert-status");
      if (!res.ok) throw new Error(t("error"));
      const body = await res.json();
      setStatus(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const severity: CertSeverity = status?.severity ?? "ok";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && (
          <p className="text-muted-foreground text-sm">{t("loading")}</p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!loading && !error && status && !status.configured && (
          <p className="text-muted-foreground text-sm">{t("notConfigured")}</p>
        )}
        {!loading && !error && status?.configured && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant={SEVERITY_VARIANT[severity]}>{t(severity)}</Badge>
              <span className="text-sm font-medium">
                {t("daysRemaining", { days: status.daysRemaining ?? 0 })}
              </span>
            </div>
            <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="font-medium">{t("subject")}</dt>
              <dd>{status.subject}</dd>
              <dt className="font-medium">{t("issuer")}</dt>
              <dd>{status.issuer}</dd>
              <dt className="font-medium">{t("validFrom")}</dt>
              <dd>{status.validFrom}</dd>
              <dt className="font-medium">{t("validTo")}</dt>
              <dd>{status.validTo}</dd>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
