"use client";

import {
  ChevronsUpDown,
  CirclePlus,
  Copy,
  MoreVertical,
  Pencil,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { RoleFormDialog } from "@/components/roles/role-form-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ── Types ───────────────────────────────────────────────────────

interface Role {
  id: number;
  name: string;
  description: string | null;
  is_builtin: boolean;
  mfa_required: boolean;
  permissions: string[];
  account_count: number;
}

interface RoleTableProps {
  canWrite: boolean;
  canDelete: boolean;
}

// ── Component ───────────────────────────────────────────────────

export function RoleTable({ canWrite, canDelete }: RoleTableProps) {
  const t = useTranslations("roles");

  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | undefined>();
  const [cloneSource, setCloneSource] = useState<Role | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Fetch roles ────────────────────────────────────────────────

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/roles");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }
      const body = await res.json();
      setRoles(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  // ── Selection ────────────────────────────────────────────────

  const allSelected = roles.length > 0 && selected.size === roles.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(roles.map((r) => r.id)));
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

  // ── Handlers ──────────────────────────────────────────────────

  const handleCreate = () => {
    setEditingRole(undefined);
    setCloneSource(undefined);
    setFormOpen(true);
  };

  const handleEdit = (role: Role) => {
    setEditingRole(role);
    setCloneSource(undefined);
    setFormOpen(true);
  };

  const handleClone = (role: Role) => {
    setEditingRole(undefined);
    setCloneSource(role);
    setFormOpen(true);
  };

  const handleToggleMfa = async (role: Role) => {
    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const res = await fetch(`/api/roles/${role.id}/mfa-required`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ mfaRequired: !role.mfa_required }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }

      fetchRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    }
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

      const res = await fetch(`/api/roles/${deleteTarget.id}`, {
        method: "DELETE",
        headers,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }

      setDeleteTarget(null);
      fetchRoles();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("error"));
    }
  };

  // ── Render ────────────────────────────────────────────────────

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
            {canWrite && (
              <Button onClick={handleCreate} className="rounded-full">
                <CirclePlus className="mr-2 h-4 w-4" />
                {t("create")}
              </Button>
            )}
          </div>
        </div>

        {loading && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("loading")}
          </p>
        )}
        {error && <p className="text-destructive px-6 pb-4 text-sm">{error}</p>}

        {!loading && !error && roles.length === 0 && (
          <p className="text-muted-foreground px-6 pb-4 text-sm">
            {t("noResults")}
          </p>
        )}

        {!loading && roles.length > 0 && (
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
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                  >
                    {t("description")}
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  </button>
                </TableHead>
                <TableHead className="text-center">
                  {t("permissionCount")}
                </TableHead>
                <TableHead className="text-center">
                  {t("accountCount")}
                </TableHead>
                <TableHead className="text-center">
                  {t("mfaRequired")}
                </TableHead>
                {(canWrite || canDelete) && <TableHead className="w-[40px]" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="pl-6">
                    <Checkbox
                      checked={selected.has(role.id)}
                      onCheckedChange={() => toggleOne(role.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="mr-2">{role.name}</span>
                    {role.is_builtin && (
                      <Badge variant="secondary" className="text-xs">
                        {t("builtin")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {role.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    {role.permissions.length}
                  </TableCell>
                  <TableCell className="text-center">
                    {role.account_count}
                  </TableCell>
                  <TableCell className="text-center">
                    {role.mfa_required ? (
                      <Badge variant="default">{t("mfaRequired")}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  {(canWrite || canDelete) && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canWrite && !role.is_builtin && (
                            <DropdownMenuItem onClick={() => handleEdit(role)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              {t("edit")}
                            </DropdownMenuItem>
                          )}
                          {canWrite && (
                            <DropdownMenuItem onClick={() => handleClone(role)}>
                              <Copy className="mr-2 h-4 w-4" />
                              {t("clone")}
                            </DropdownMenuItem>
                          )}
                          {canWrite && (
                            <DropdownMenuItem
                              onClick={() => handleToggleMfa(role)}
                            >
                              <ShieldCheck className="mr-2 h-4 w-4" />
                              {t("toggleMfa")}
                            </DropdownMenuItem>
                          )}
                          {canDelete && !role.is_builtin && (
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(role)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t("delete")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create/Edit/Clone Dialog */}
      {canWrite && (
        <RoleFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          role={editingRole}
          cloneSource={cloneSource}
          onSuccess={fetchRoles}
        />
      )}

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
