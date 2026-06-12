"use client";

import { CirclePlus, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Timestamp } from "@/components/timestamp";
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
import type { TriagePolicyRow } from "@/lib/triage/policy/types";

import { TriagePolicyFormDialog } from "./triage-policy-form-dialog";

interface CustomerOption {
  id: number;
  name: string;
}

interface TriagePolicyManagerProps {
  /**
   * Customer options sourced from the caller's effective triage scope on
   * the server (`getEffectiveCustomerScope(session)`). The page is gated
   * by `triage:read` only — `customers:read` is intentionally NOT
   * required, so a `triage:policy:write` user without the customer
   * permission can still use this UI.
   */
  customers: CustomerOption[];
  /**
   * True iff the session holds `triage:policy:write`. Hides the create
   * button and per-row edit/delete affordances when false so a
   * read-only triage user does not see controls they'd only be denied
   * at submit time.
   */
  canWritePolicy: boolean;
}

export function TriagePolicyManager({
  customers,
  canWritePolicy,
}: TriagePolicyManagerProps) {
  const t = useTranslations("triagePolicies");

  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(
    customers[0]?.id ?? null,
  );

  const [policies, setPolicies] = useState<TriagePolicyRow[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policiesError, setPoliciesError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<
    TriagePolicyRow | undefined
  >();
  const [deleteTarget, setDeleteTarget] = useState<TriagePolicyRow | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // ── Policy fetch when customer changes ────────────────────────

  const fetchPolicies = useCallback(
    async (customerId: number | null) => {
      if (customerId === null) {
        setPolicies([]);
        return;
      }
      setPoliciesLoading(true);
      setPoliciesError(null);
      try {
        const res = await fetch(
          `/api/triage/policies?customer_id=${customerId}`,
        );
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? t("error"));
        }
        const body = await res.json();
        setPolicies(body.data as TriagePolicyRow[]);
      } catch (err) {
        setPoliciesError(err instanceof Error ? err.message : t("error"));
      } finally {
        setPoliciesLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void fetchPolicies(selectedCustomerId);
  }, [fetchPolicies, selectedCustomerId]);

  // ── Handlers ────────────────────────────────────────────────

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

  const handleCreate = () => {
    setEditingPolicy(undefined);
    setFormOpen(true);
  };

  const handleEdit = (policy: TriagePolicyRow) => {
    setEditingPolicy(policy);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget || selectedCustomerId === null) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      const res = await fetch(
        `/api/triage/policies/${deleteTarget.id}?customer_id=${selectedCustomerId}`,
        { method: "DELETE", headers },
      );
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }
      setDeleteTarget(null);
      void fetchPolicies(selectedCustomerId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("error"));
    } finally {
      setDeleteSubmitting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-card">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-foreground text-lg font-semibold">
              {t("title")}
            </h1>
            <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="triage-policy-customer" className="text-sm">
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
                <SelectTrigger id="triage-policy-customer" className="min-w-48">
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
            {canWritePolicy && (
              <Button
                onClick={handleCreate}
                className="rounded-full"
                disabled={selectedCustomerId === null}
              >
                <CirclePlus className="mr-2 h-4 w-4" />
                {t("create")}
              </Button>
            )}
          </div>
        </div>

        {customers.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noCustomerScope")}
          </p>
        )}

        {selectedCustomerId !== null && (
          <>
            {policiesLoading && (
              <p className="text-muted-foreground px-6 pb-4 text-sm">
                {t("loading")}
              </p>
            )}
            {policiesError && (
              <p className="text-destructive px-6 pb-4 text-sm">
                {policiesError}
              </p>
            )}
            {!policiesLoading && !policiesError && policies.length === 0 && (
              <p className="text-muted-foreground px-6 pb-4 text-sm">
                {t("noResults")}
              </p>
            )}
            {!policiesLoading && policies.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">{t("name")}</TableHead>
                    <TableHead>{t("ruleCounts")}</TableHead>
                    <TableHead>{t("createdAt")}</TableHead>
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="pl-6 font-medium">
                        {p.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {t("ruleCountsValue", {
                          packetAttr: p.packet_attr.length,
                          confidence: p.confidence.length,
                          response: p.response.length,
                        })}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        <Timestamp at={p.created_at} />
                      </TableCell>
                      <TableCell>
                        {canWritePolicy && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-xs">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEdit(p)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                {t("edit")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setDeleteTarget(p)}
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
          </>
        )}
      </div>

      {selectedCustomer && canWritePolicy && (
        <TriagePolicyFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          policy={editingPolicy}
          customerId={selectedCustomer.id}
          onSuccess={() => fetchPolicies(selectedCustomer.id)}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            if (deleteSubmitting) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-destructive text-sm">{deleteError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSubmitting}>
              {t("cancel")}
            </AlertDialogCancel>
            {/*
             * Radix's AlertDialogAction closes the dialog by default,
             * which would unmount the error message and clear
             * deleteTarget before a failed DELETE could be shown. Call
             * `event.preventDefault()` to keep the dialog open while
             * the request is in flight; handleDelete closes the dialog
             * itself on success.
             */}
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
