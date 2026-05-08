"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ALL_PERMISSIONS } from "@/lib/auth/permission-defs";

// ── Types ───────────────────────────────────────────────────────

export interface Role {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
}

export interface RoleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: Role;
  cloneSource?: Role;
  onSuccess: () => void;
}

export interface RoleFormPayload {
  name: string;
  description: string | null;
  permissions: string[];
}

// ── Pure helpers ────────────────────────────────────────────────

// `useState`'s initializer runs on the very first render so the SSR
// pass already commits with the correct pre-checked permissions —
// without this, the first paint flashed an empty checkbox grid and
// `useEffect` patched it on the client. Reviewer Round 1 (#354)
// flagged the resulting test gap.
export function initialPermissionsFor(
  role?: Role,
  cloneSource?: Role,
): Set<string> {
  if (role) return new Set(role.permissions);
  if (cloneSource) return new Set(cloneSource.permissions);
  return new Set();
}

export function togglePermissionIn(
  current: Set<string>,
  permission: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(permission)) {
    next.delete(permission);
  } else {
    next.add(permission);
  }
  return next;
}

export function buildRolePayload(
  name: string,
  description: string,
  selectedPermissions: Set<string>,
): RoleFormPayload {
  return {
    name: name.trim(),
    description: description.trim() || null,
    permissions: [...selectedPermissions],
  };
}

// ── Hook ────────────────────────────────────────────────────────

interface UseRoleFormArgs {
  open: boolean;
  role?: Role;
  cloneSource?: Role;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  errorFallback: string;
}

export interface UseRoleFormResult {
  name: string;
  description: string;
  selectedPermissions: Set<string>;
  submitting: boolean;
  error: string | null;
  isEdit: boolean;
  isValid: boolean;
  setName: (next: string) => void;
  setDescription: (next: string) => void;
  togglePermission: (permission: string) => void;
  handleSubmit: (event?: { preventDefault?: () => void }) => Promise<void>;
}

export function useRoleForm({
  open,
  role,
  cloneSource,
  onOpenChange,
  onSuccess,
  errorFallback,
}: UseRoleFormArgs): UseRoleFormResult {
  const isEdit = !!role;

  const [name, setName] = useState<string>(() => role?.name ?? "");
  const [description, setDescription] = useState<string>(
    () => (role ?? cloneSource)?.description ?? "",
  );
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    () => initialPermissionsFor(role, cloneSource),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/changes. The `useState` initializers
  // above keep the very first render in sync; this effect handles
  // subsequent transitions (close/reopen, swap edit→clone).
  useEffect(() => {
    if (!open) return;
    if (role) {
      setName(role.name);
      setDescription(role.description ?? "");
      setSelectedPermissions(new Set(role.permissions));
    } else if (cloneSource) {
      setName("");
      setDescription(cloneSource.description ?? "");
      setSelectedPermissions(new Set(cloneSource.permissions));
    } else {
      setName("");
      setDescription("");
      setSelectedPermissions(new Set());
    }
    setError(null);
  }, [open, role, cloneSource]);

  const togglePermission = useCallback((permission: string) => {
    setSelectedPermissions((prev) => togglePermissionIn(prev, permission));
  }, []);

  const handleSubmit = useCallback(
    async (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      setSubmitting(true);
      setError(null);

      try {
        const csrfToken = readCsrfToken();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (csrfToken) {
          headers["X-CSRF-Token"] = csrfToken;
        }

        const payload = buildRolePayload(
          name,
          description,
          selectedPermissions,
        );

        const url = role ? `/api/roles/${role.id}` : "/api/roles";
        const method = role ? "PATCH" : "POST";

        const res = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? errorFallback);
        }

        onOpenChange(false);
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : errorFallback);
      } finally {
        setSubmitting(false);
      }
    },
    [
      name,
      description,
      selectedPermissions,
      role,
      errorFallback,
      onOpenChange,
      onSuccess,
    ],
  );

  const isValid = name.trim().length > 0;

  return {
    name,
    description,
    selectedPermissions,
    submitting,
    error,
    isEdit,
    isValid,
    setName,
    setDescription,
    togglePermission,
    handleSubmit,
  };
}

// ── Component ───────────────────────────────────────────────────

export function RoleFormDialog({
  open,
  onOpenChange,
  role,
  cloneSource,
  onSuccess,
}: RoleFormDialogProps) {
  const t = useTranslations("roles");
  const form = useRoleForm({
    open,
    role,
    cloneSource,
    onOpenChange,
    onSuccess,
    errorFallback: t("error"),
  });

  const dialogTitle = form.isEdit
    ? t("edit")
    : cloneSource
      ? t("clone")
      : t("create");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit} className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="role-name">{t("name")}</Label>
            <Input
              id="role-name"
              value={form.name}
              onChange={(e) => form.setName(e.target.value)}
              required
              maxLength={100}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="role-description">{t("description")}</Label>
            <Input
              id="role-description"
              value={form.description}
              onChange={(e) => form.setDescription(e.target.value)}
            />
          </div>

          {/* Permission checkbox grid */}
          <div className="space-y-3">
            <Label>{t("permissions")}</Label>
            <div className="bg-muted/50 space-y-4 rounded p-3">
              {Object.entries(ALL_PERMISSIONS).map(([group, perms]) => (
                <div key={group}>
                  <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
                    {t(`permissionGroups.${group}`)}
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {perms.map((perm) => {
                      const checkboxId = `perm-${perm}`;
                      return (
                        <div
                          key={perm}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={checkboxId}
                            checked={form.selectedPermissions.has(perm)}
                            onCheckedChange={() => form.togglePermission(perm)}
                          />
                          <label htmlFor={checkboxId}>
                            {t(`permissionLabels.${perm}`)}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {form.error && (
            <p className="text-destructive text-sm">{form.error}</p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={form.submitting}
              >
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={form.submitting || !form.isValid}>
              {form.submitting
                ? t("loading")
                : form.isEdit
                  ? t("edit")
                  : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
