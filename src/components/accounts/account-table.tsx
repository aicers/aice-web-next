"use client";

import {
  ChevronsUpDown,
  CirclePlus,
  MoreVertical,
  Pencil,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { AccountFormDialog } from "@/components/accounts/account-form-dialog";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import { formatDateTime } from "@/lib/format-date";

// ── Types ───────────────────────────────────────────────────────

interface Account {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_name: string;
  status: string;
  last_sign_in_at: string | null;
  created_at: string;
  has_mfa: boolean;
}

interface Role {
  id: number;
  name: string;
  requires_customer_assignment: boolean;
  max_customer_assignments: number | null;
  tenant_manageable: boolean;
}

interface Customer {
  id: number;
  name: string;
}

// ── Constants ───────────────────────────────────────────────────

const PAGE_SIZE = 20;

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  locked: "destructive",
  suspended: "destructive",
  disabled: "secondary",
};

// ── Helpers ─────────────────────────────────────────────────────

function buildPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | "...")[] = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push("...", total);
  } else if (current >= total - 3) {
    pages.push(1, "...");
    for (let i = total - 4; i <= total; i++) pages.push(i);
  } else {
    pages.push(1, "...", current - 1, current, current + 1, "...", total);
  }
  return pages;
}

// ── Component ───────────────────────────────────────────────────

export function AccountTable() {
  const t = useTranslations("accounts");
  const tz = useTimezone();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filters
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");

  // Reference data
  const [roles, setRoles] = useState<Role[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // MFA reset state
  const [mfaResetTarget, setMfaResetTarget] = useState<Account | null>(null);
  const [mfaResetPassword, setMfaResetPassword] = useState("");
  const [mfaResetError, setMfaResetError] = useState<string | null>(null);
  const [mfaResetLoading, setMfaResetLoading] = useState(false);
  const [mfaResetSuccess, setMfaResetSuccess] = useState<string | null>(null);

  // ── Fetch reference data ────────────────────────────────────────

  useEffect(() => {
    fetch("/api/roles")
      .then((res) => res.json())
      .then((body) => setRoles(body.data ?? []))
      .catch(() => {});

    fetch("/api/customers")
      .then((res) => res.json())
      .then((body) => setCustomers(body.data ?? []))
      .catch(() => {});
  }, []);

  // ── Fetch accounts ─────────────────────────────────────────────

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      if (search) params.set("search", search);
      if (roleFilter) params.set("role", roleFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (customerFilter) params.set("customerId", customerFilter);

      const res = await fetch(`/api/accounts?${params}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }
      const body = await res.json();
      setAccounts(body.data);
      setTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [page, search, roleFilter, statusFilter, customerFilter, t]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // ── Selection ────────────────────────────────────────────────

  const allSelected = accounts.length > 0 && selected.size === accounts.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(accounts.map((a) => a.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Handlers ───────────────────────────────────────────────────

  const handleCreate = () => {
    setEditingAccount(undefined);
    setFormOpen(true);
  };

  const handleEdit = (account: Account) => {
    setEditingAccount(account);
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

      const res = await fetch(`/api/accounts/${deleteTarget.id}`, {
        method: "DELETE",
        headers,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }

      setDeleteTarget(null);
      fetchAccounts();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("error"));
    }
  };

  const handleMfaReset = async () => {
    if (!mfaResetTarget || !mfaResetPassword) return;
    setMfaResetLoading(true);
    setMfaResetError(null);

    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const res = await fetch(`/api/accounts/${mfaResetTarget.id}/mfa-reset`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password: mfaResetPassword }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("mfaResetError"));
      }

      const username = mfaResetTarget.username;
      setMfaResetTarget(null);
      setMfaResetPassword("");
      setMfaResetSuccess(t("mfaResetSuccess", { username }));
      fetchAccounts();
    } catch (err) {
      setMfaResetError(err instanceof Error ? err.message : t("mfaResetError"));
    } finally {
      setMfaResetLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const pageNumbers = buildPageNumbers(page, totalPages);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Filters */}
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-3">
        <Input
          placeholder={t("search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
        <Select
          value={roleFilter}
          onValueChange={(v) => {
            setRoleFilter(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder={t("allRoles")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allRoles")}</SelectItem>
            {roles.map((role) => (
              <SelectItem key={role.id} value={role.name}>
                {role.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("allStatuses")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allStatuses")}</SelectItem>
            <SelectItem value="active">{t("active")}</SelectItem>
            <SelectItem value="locked">{t("locked")}</SelectItem>
            <SelectItem value="suspended">{t("suspended")}</SelectItem>
            <SelectItem value="disabled">{t("disabled")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={customerFilter}
          onValueChange={(v) => {
            setCustomerFilter(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder={t("allCustomers")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allCustomers")}</SelectItem>
            {customers.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </form>

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

        {!loading && !error && accounts.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noResults")}
          </p>
        )}

        {!loading && accounts.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px] pl-6">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                    >
                      {t("username")}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                    >
                      {t("displayName")}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                    >
                      {t("role")}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                    >
                      {t("status")}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                    >
                      {t("lastSignIn")}
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell className="pl-6">
                      <Checkbox
                        checked={selected.has(account.id)}
                        onCheckedChange={() => toggleOne(account.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {account.username}
                    </TableCell>
                    <TableCell>{account.display_name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {account.role_name}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATUS_VARIANT[account.status] ?? "secondary"}
                        className="text-xs"
                      >
                        {t(
                          account.status as
                            | "active"
                            | "locked"
                            | "suspended"
                            | "disabled",
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {account.last_sign_in_at
                        ? formatDateTime(account.last_sign_in_at, tz)
                        : t("never")}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(account)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            {t("edit")}
                          </DropdownMenuItem>
                          {account.has_mfa && (
                            <DropdownMenuItem
                              onClick={() => setMfaResetTarget(account)}
                            >
                              <ShieldOff className="mr-2 h-4 w-4" />
                              {t("mfaReset")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setDeleteTarget(account)}
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

            {/* Numbered pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-1 py-4">
                {pageNumbers.map((p, i) =>
                  p === "..." ? (
                    <span
                      key={i === 1 ? "ellipsis-start" : "ellipsis-end"}
                      className="text-muted-foreground flex h-8 w-8 items-center justify-center text-sm"
                    >
                      ...
                    </span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPage(p)}
                      className={`flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors ${
                        p === page
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p}
                    </button>
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <AccountFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        account={editingAccount}
        roles={roles}
        customers={customers}
        onSuccess={fetchAccounts}
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

      {/* MFA Reset Confirmation */}
      <AlertDialog
        open={!!mfaResetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setMfaResetTarget(null);
            setMfaResetPassword("");
            setMfaResetError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mfaReset")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mfaResetDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            type="password"
            placeholder={t("mfaResetConfirm")}
            value={mfaResetPassword}
            onChange={(e) => setMfaResetPassword(e.target.value)}
            autoComplete="current-password"
          />
          {mfaResetError && (
            <p className="text-destructive text-sm">{mfaResetError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleMfaReset();
              }}
              disabled={!mfaResetPassword || mfaResetLoading}
            >
              {t("mfaReset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* MFA Reset Success */}
      {mfaResetSuccess && (
        <AlertDialog open onOpenChange={() => setMfaResetSuccess(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("mfaReset")}</AlertDialogTitle>
              <AlertDialogDescription>{mfaResetSuccess}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setMfaResetSuccess(null)}>
                OK
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
