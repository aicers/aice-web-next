"use client";

import {
  ChevronsUpDown,
  CirclePlus,
  MoreVertical,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { CustomerFormDialog } from "@/components/customers/customer-form-dialog";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ── Types ───────────────────────────────────────────────────────

interface Customer {
  id: number;
  name: string;
  description: string | null;
  database_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// ── Component ───────────────────────────────────────────────────

export function CustomerTable() {
  const t = useTranslations("customers");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<
    Customer | undefined
  >();
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/customers");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }
      const body = await res.json();
      setCustomers(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // ── Selection ────────────────────────────────────────────────

  const allSelected =
    customers.length > 0 && selected.size === customers.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(customers.map((c) => c.id)));
    }
  };

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Handlers ───────────────────────────────────────────────────

  const handleCreate = () => {
    setEditingCustomer(undefined);
    setFormOpen(true);
  };

  const handleEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);

    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const res = await fetch(`/api/customers/${deleteTarget.id}`, {
        method: "DELETE",
        headers,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }

      setDeleteTarget(null);
      fetchCustomers();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("error"));
    }
  };

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Card container */}
      <div className="rounded-lg bg-card">
        {/* Title bar inside card */}
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-foreground text-lg font-semibold">
            {t("title")}
          </h1>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="default">
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              {t("latest")}
            </Button>
            <Button onClick={handleCreate} className="rounded-full">
              <CirclePlus className="mr-2 h-4 w-4" />
              {t("create")}
            </Button>
          </div>
        </div>

        {loading && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("loading")}
          </p>
        )}
        {error && <p className="text-destructive px-6 pb-4 text-sm">{error}</p>}

        {!loading && !error && customers.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noResults")}
          </p>
        )}

        {!loading && customers.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] pl-6">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                  >
                    {t("name")}
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  </button>
                </TableHead>
                <TableHead>{t("description")}</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell className="pl-6">
                    <Checkbox
                      checked={selected.has(customer.id)}
                      onCheckedChange={() => toggleOne(customer.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{customer.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {customer.description ?? "-"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(customer)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          {t("edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeleteTarget(customer)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t("delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <CustomerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        customer={editingCustomer}
        onSuccess={fetchCustomers}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
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
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
