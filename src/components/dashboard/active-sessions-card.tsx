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

interface Session {
  sid: string;
  account_id: string;
  username: string;
  display_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  needs_reauth: boolean;
}

// ── Component ────────────────────────────────────────────────────

export function ActiveSessionsCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations("dashboard.activeSessions");
  const tc = useTranslations("common");
  const tz = useTimezone();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/sessions");
      if (!res.ok) throw new Error(t("error"));
      const body = await res.json();
      setSessions(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRevoke = useCallback(
    async (sid: string) => {
      setRevokingId(sid);
      try {
        const csrf = readCsrfToken();
        const res = await fetch(`/api/dashboard/sessions/${sid}/revoke`, {
          method: "POST",
          headers: {
            "x-csrf-token": csrf ?? "",
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) throw new Error(t("revokeError"));
        setSessions((prev) => prev.filter((s) => s.sid !== sid));
      } catch {
        setError(t("revokeError"));
      } finally {
        setRevokingId(null);
      }
    },
    [t],
  );

  /** Truncate user agent to first meaningful part. */
  function shortUa(ua: string | null): string {
    if (!ua) return "-";
    // Show first 40 chars
    return ua.length > 40 ? `${ua.slice(0, 40)}...` : ua;
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
        {!loading && !error && sessions.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("noSessions")}</p>
        )}
        {!loading && !error && sessions.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("username")}</TableHead>
                  <TableHead>{t("ipAddress")}</TableHead>
                  <TableHead>{t("userAgent")}</TableHead>
                  <TableHead>{t("lastActive")}</TableHead>
                  <TableHead>{t("createdAt")}</TableHead>
                  <TableHead>{t("needsReauth")}</TableHead>
                  {canWrite && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.sid}>
                    <TableCell className="text-xs font-medium">
                      {s.display_name ?? s.username}
                    </TableCell>
                    <TableCell className="text-xs">
                      {s.ip_address ?? "-"}
                    </TableCell>
                    <TableCell className="max-w-[200px] text-xs">
                      {shortUa(s.user_agent)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(s.last_active_at, tz)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(s.created_at, tz)}
                    </TableCell>
                    <TableCell>
                      {s.needs_reauth && (
                        <Badge variant="destructive">{t("needsReauth")}</Badge>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={revokingId === s.sid}
                            >
                              {t("revoke")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t("revoke")}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("revokeConfirm")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {tc("cancel")}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRevoke(s.sid)}
                              >
                                {t("revoke")}
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
