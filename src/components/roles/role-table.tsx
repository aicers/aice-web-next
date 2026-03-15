"use client";

import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
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
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
        {canWrite && (
          <Button onClick={handleCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t("create")}
          </Button>
        )}
      </div>

      {loading && (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {!loading && !error && roles.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("noResults")}</p>
      )}

      {!loading && roles.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("description")}</TableHead>
              <TableHead className="text-center">
                {t("permissionCount")}
              </TableHead>
              <TableHead className="text-center">{t("accountCount")}</TableHead>
              {(canWrite || canDelete) && <TableHead className="w-[120px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
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
                {(canWrite || canDelete) && (
                  <TableCell>
                    <div className="flex gap-1">
                      {canWrite && !role.is_builtin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(role)}
                          title={t("edit")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleClone(role)}
                          title={t("clone")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && !role.is_builtin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(role)}
                          title={t("delete")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

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
