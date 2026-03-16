"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format-date";

// ── Types ────────────────────────────────────────────────────────

type AlertSeverity = "critical" | "high" | "medium" | "low";

interface Alert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  message: string;
  count: number;
  latest_at: string;
}

// ── Severity badge styles ────────────────────────────────────────

const SEVERITY_VARIANT: Record<
  AlertSeverity,
  "destructive" | "default" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "default",
  medium: "secondary",
  low: "outline",
};

// ── Component ────────────────────────────────────────────────────

export function SuspiciousAlertsCard() {
  const t = useTranslations("dashboard.alerts");
  const tz = useTimezone();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/alerts");
      if (!res.ok) throw new Error(t("error"));
      const body = await res.json();
      setAlerts(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

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
        {!loading && !error && alerts.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("noAlerts")}</p>
        )}
        {!loading && !error && alerts.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("severity")}</TableHead>
                  <TableHead>{t("rule")}</TableHead>
                  <TableHead>{t("message")}</TableHead>
                  <TableHead>{t("count")}</TableHead>
                  <TableHead>{t("latestAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Badge variant={SEVERITY_VARIANT[a.severity]}>
                        {t(a.severity)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {t(`rules.${a.rule}` as Parameters<typeof t>[0])}
                    </TableCell>
                    <TableCell className="max-w-[300px] text-xs">
                      {a.message}
                    </TableCell>
                    <TableCell className="text-xs">{a.count}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(a.latest_at, tz)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
