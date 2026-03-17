"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

interface LockedAccount {
  id: string;
  username: string;
  display_name: string | null;
  role_name: string;
  status: string;
  locked_until: string | null;
  failed_sign_in_count: number;
  updated_at: string;
}

// ── Component ────────────────────────────────────────────────────

export function LockedAccountsCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations("dashboard.lockedAccounts");
  const tz = useTimezone();

  const [accounts, setAccounts] = useState<LockedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/locked-accounts");
      if (!res.ok) throw new Error(t("error"));
      const body = await res.json();
      setAccounts(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleResolve = useCallback(
    async (account: LockedAccount) => {
      setPendingId(account.id);
      setError(null);
      try {
        const csrf = readCsrfToken();
        const res = await fetch(`/api/accounts/${account.id}/unlock`, {
          method: "POST",
          headers: {
            "x-csrf-token": csrf ?? "",
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(t("actionError"));
        }

        setAccounts((prev) => prev.filter((item) => item.id !== account.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : t("actionError"));
      } finally {
        setPendingId(null);
      }
    },
    [t],
  );

  function actionLabel(status: string) {
    return status === "locked" ? t("unlock") : t("restore");
  }

  function actionConfirm(status: string) {
    return status === "locked" ? t("unlockConfirm") : t("restoreConfirm");
  }

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
        {!loading && !error && accounts.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("noAccounts")}</p>
        )}
        {!loading && !error && accounts.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("username")}</TableHead>
                  <TableHead>{t("role")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("failedAttempts")}</TableHead>
                  <TableHead>{t("lockedUntil")}</TableHead>
                  <TableHead>{t("updatedAt")}</TableHead>
                  {canWrite && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs font-medium">
                      {a.display_name ?? a.username}
                    </TableCell>
                    <TableCell className="text-xs">{a.role_name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          a.status === "locked" ? "destructive" : "secondary"
                        }
                      >
                        {a.status === "locked" ? t("locked") : t("suspended")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {a.failed_sign_in_count}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {a.locked_until
                        ? formatDateTime(a.locked_until, tz)
                        : "-"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(a.updated_at, tz)}
                    </TableCell>
                    {canWrite && (
                      <TableCell>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={pendingId === a.id}
                            >
                              {actionLabel(a.status)}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {actionLabel(a.status)}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {actionConfirm(a.status)}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {t("cancel")}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleResolve(a)}
                              >
                                {actionLabel(a.status)}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    )}
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
