"use client";

import { CirclePlus, MoreVertical, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { readCsrfToken } from "@/lib/csrf-client";

import { TriageExclusionFormDialog } from "./triage-exclusion-form-dialog";

interface CustomerOption {
  id: number;
  name: string;
}

interface ExclusionRow {
  id: string;
  kind: "ipAddress" | "hostname" | "uri" | "domain";
  value: string;
  domainSuffix: string | null;
  note: string | null;
  createdBy: string;
  createdByDisplayName: string | null;
  createdAt: string;
}

interface ManagerProps {
  scope: "global" | "customer";
  customers?: CustomerOption[];
  canMutate: boolean;
}

export function TriageExclusionManager({
  scope,
  customers = [],
  canMutate,
}: ManagerProps) {
  const t = useTranslations("triageExclusions");

  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(
    customers[0]?.id ?? null,
  );
  const [rows, setRows] = useState<ExclusionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ExclusionRow | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const baseUrl = useMemo(() => {
    if (scope === "global") return "/api/triage/exclusions/global";
    return selectedCustomerId === null
      ? null
      : `/api/triage/exclusions?customer_id=${selectedCustomerId}`;
  }, [scope, selectedCustomerId]);

  const fetchRows = useCallback(async () => {
    if (scope === "customer" && selectedCustomerId === null) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url =
        scope === "global"
          ? "/api/triage/exclusions/global"
          : `/api/triage/exclusions?customer_id=${selectedCustomerId}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? t("error"));
      }
      const body = (await res.json()) as { data: ExclusionRow[] };
      setRows(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [scope, selectedCustomerId, t]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      const url =
        scope === "global"
          ? `/api/triage/exclusions/global/${deleteTarget.id}`
          : `/api/triage/exclusions/${deleteTarget.id}?customer_id=${selectedCustomerId}`;
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? t("error"));
      }
      setDeleteTarget(null);
      void fetchRows();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("error"));
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const kindLabel = (kind: ExclusionRow["kind"]): string => {
    switch (kind) {
      case "ipAddress":
        return t("kindIpAddress");
      case "hostname":
        return t("kindHostname");
      case "uri":
        return t("kindUri");
      case "domain":
        return t("kindDomain");
    }
  };

  const showCreate = canMutate && (scope === "global" || baseUrl !== null);

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-card">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-foreground text-lg font-semibold">
              {scope === "global" ? t("globalTitle") : t("customerTitle")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {scope === "global" ? t("globalSubtitle") : t("customerSubtitle")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {scope === "customer" && (
              <div className="flex items-center gap-2">
                <Label htmlFor="exclusion-customer" className="text-sm">
                  {t("customer")}
                </Label>
                <Select
                  value={
                    selectedCustomerId !== null
                      ? String(selectedCustomerId)
                      : undefined
                  }
                  onValueChange={(v) => setSelectedCustomerId(Number(v))}
                  disabled={customers.length === 0}
                >
                  <SelectTrigger id="exclusion-customer" className="min-w-48">
                    <SelectValue placeholder={t("selectCustomer")} />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showCreate && (
              <Button
                onClick={() => setFormOpen(true)}
                className="rounded-full"
                disabled={scope === "customer" && selectedCustomerId === null}
              >
                <CirclePlus className="mr-2 h-4 w-4" />
                {t("create")}
              </Button>
            )}
          </div>
        </div>

        {scope === "customer" && customers.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noCustomerScope")}
          </p>
        )}

        {loading && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("loading")}
          </p>
        )}
        {error && <p className="text-destructive px-6 pb-4 text-sm">{error}</p>}
        {!loading && !error && rows.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noResults")}
          </p>
        )}
        {!loading && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t("kind")}</TableHead>
                <TableHead>{t("value")}</TableHead>
                <TableHead>{t("note")}</TableHead>
                <TableHead>{t("createdBy")}</TableHead>
                <TableHead>{t("createdAt")}</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-6">{kindLabel(r.kind)}</TableCell>
                  <TableCell className="font-mono text-xs break-all">
                    {r.value}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {r.note ?? ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {r.createdByDisplayName ?? r.createdBy}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {r.createdAt}
                  </TableCell>
                  <TableCell>
                    {canMutate && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setDeleteTarget(r)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {canMutate && (
        <TriageExclusionFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          scope={scope}
          customerId={selectedCustomerId ?? undefined}
          onSuccess={fetchRows}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteSubmitting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-destructive text-sm">{deleteError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSubmitting}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              disabled={deleteSubmitting}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
