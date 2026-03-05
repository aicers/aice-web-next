"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ── Types ────────────────────────────────────────────────────────

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  correlation_id: string | null;
}

interface SearchResult {
  data: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Constants ────────────────────────────────────────────────────

const ACTION_KEYS = [
  "auth.sign_in.success",
  "auth.sign_in.failure",
  "auth.sign_out",
  "auth.session_extend",
  "session.ip_mismatch",
  "session.ua_mismatch",
  "session.ip_ua_mismatch",
  "session.revoke",
  "session.reauth_required",
  "session.reauth_success",
  "session.reauth_failure",
  "session.idle_timeout",
  "session.absolute_timeout",
  "account.create",
  "account.lock",
  "account.unlock",
] as const;

const TARGET_TYPE_KEYS = ["account", "session"] as const;

/** Convert a dotted DB action key to an i18n-safe underscore key. */
function actionToI18nKey(action: string): string {
  return action.replaceAll(".", "_");
}

// ── Component ────────────────────────────────────────────────────

export function AuditLogTable() {
  const t = useTranslations("auditLogs");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Local filter state (synced from URL on mount) ───────────

  const [from, setFrom] = useState(searchParams.get("from") ?? "");
  const [to, setTo] = useState(searchParams.get("to") ?? "");
  const [actor, setActor] = useState(searchParams.get("actor") ?? "");
  const [action, setAction] = useState(searchParams.get("action") ?? "");
  const [targetType, setTargetType] = useState(
    searchParams.get("targetType") ?? "",
  );
  const [targetId, setTargetId] = useState(searchParams.get("targetId") ?? "");
  const [correlationId, setCorrelationId] = useState(
    searchParams.get("correlationId") ?? "",
  );

  // ── URL helpers ─────────────────────────────────────────────

  const buildParams = useCallback(
    (overrides: Record<string, string | null> = {}) => {
      const base: Record<string, string> = {};
      if (from) base.from = from;
      if (to) base.to = to;
      if (actor) base.actor = actor;
      if (action) base.action = action;
      if (targetType) base.targetType = targetType;
      if (targetId) base.targetId = targetId;
      if (correlationId) base.correlationId = correlationId;

      const merged = { ...base, ...overrides };
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) {
        if (v) params.set(k, v);
      }
      return params;
    },
    [from, to, actor, action, targetType, targetId, correlationId],
  );

  // ── Fetch ───────────────────────────────────────────────────

  const fetchLogs = useCallback(
    async (params: URLSearchParams) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/audit-logs?${params.toString()}`);
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? "Failed to fetch");
        }
        const data: SearchResult = await res.json();
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("error"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // Fetch on URL change
  useEffect(() => {
    fetchLogs(searchParams);
  }, [searchParams, fetchLogs]);

  // ── Handlers ────────────────────────────────────────────────

  const handleSearch = useCallback(() => {
    const params = buildParams();
    router.push(`${pathname}?${params.toString()}`);
  }, [buildParams, router, pathname]);

  const handleClear = useCallback(() => {
    setFrom("");
    setTo("");
    setActor("");
    setAction("");
    setTargetType("");
    setTargetId("");
    setCorrelationId("");
    router.push(pathname);
  }, [router, pathname]);

  const handleCorrelationClick = useCallback(
    (cid: string) => {
      setCorrelationId(cid);
      setFrom("");
      setTo("");
      setActor("");
      setAction("");
      setTargetType("");
      setTargetId("");
      const params = new URLSearchParams({ correlationId: cid });
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname],
  );

  const goToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(page));
      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  // ── Derived ─────────────────────────────────────────────────

  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / result.pageSize))
    : 1;
  const currentPage = result?.page ?? 1;

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Title */}
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>

      {/* Filters */}
      <div className="bg-card space-y-4 rounded-lg border p-4">
        <h2 className="text-foreground text-sm font-medium">{t("filters")}</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label>{t("from")}</Label>
            <Input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("to")}</Label>
            <Input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("actor")}</Label>
            <Input
              type="text"
              value={actor}
              placeholder={t("actor")}
              onChange={(e) => setActor(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("action")}</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
                <SelectValue placeholder={t("allActions")} />
              </SelectTrigger>
              <SelectContent>
                {ACTION_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {t(`actions.${actionToI18nKey(key)}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("targetType")}</Label>
            <Select value={targetType} onValueChange={setTargetType}>
              <SelectTrigger>
                <SelectValue placeholder={t("allTargetTypes")} />
              </SelectTrigger>
              <SelectContent>
                {TARGET_TYPE_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {t(`targetTypes.${key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("targetId")}</Label>
            <Input
              type="text"
              value={targetId}
              placeholder={t("targetId")}
              onChange={(e) => setTargetId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("correlationId")}</Label>
            <Input
              type="text"
              value={correlationId}
              placeholder={t("correlationId")}
              onChange={(e) => setCorrelationId(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSearch}>{t("search")}</Button>
          <Button variant="outline" onClick={handleClear}>
            {t("clear")}
          </Button>
        </div>
      </div>

      {/* Loading / Error / Empty */}
      {loading && (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
      {!loading && !error && result && result.data.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("noResults")}</p>
      )}

      {/* Table */}
      {!loading && result && result.data.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("timestamp")}</TableHead>
                <TableHead>{t("actor")}</TableHead>
                <TableHead>{t("action")}</TableHead>
                <TableHead>{t("targetType")}</TableHead>
                <TableHead>{t("targetId")}</TableHead>
                <TableHead>{t("correlationId")}</TableHead>
                <TableHead>{t("ipAddress")}</TableHead>
                <TableHead>{t("details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(entry.timestamp).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">{entry.actor_id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {t(
                        `actions.${actionToI18nKey(entry.action)}` as Parameters<
                          typeof t
                        >[0],
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{entry.target_type}</TableCell>
                  <TableCell className="text-xs">
                    {entry.target_id ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {entry.correlation_id ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() =>
                          handleCorrelationClick(entry.correlation_id as string)
                        }
                      >
                        {entry.correlation_id.slice(0, 8)}...
                      </button>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {entry.ip_address ?? "-"}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs">
                    {entry.details ? JSON.stringify(entry.details) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-sm">
              {t("page", { current: currentPage, total: totalPages })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => goToPage(currentPage - 1)}
              >
                {t("previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => goToPage(currentPage + 1)}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
