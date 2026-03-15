"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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

// ── Types ───────────────────────────────────────────────────────

interface Role {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
}

interface RoleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: Role;
  cloneSource?: Role;
  onSuccess: () => void;
}

// ── Permission groups (mirrors ALL_PERMISSIONS from server) ────

const PERMISSION_GROUPS = {
  accounts: ["accounts:read", "accounts:write", "accounts:delete"],
  roles: ["roles:read", "roles:write", "roles:delete"],
  customers: [
    "customers:read",
    "customers:write",
    "customers:delete",
    "customers:access-all",
  ],
  "audit-logs": ["audit-logs:read"],
  dashboard: ["dashboard:read", "dashboard:write"],
  "system-settings": ["system-settings:read", "system-settings:write"],
} as const;

// ── Component ───────────────────────────────────────────────────

export function RoleFormDialog({
  open,
  onOpenChange,
  role,
  cloneSource,
  onSuccess,
}: RoleFormDialogProps) {
  const t = useTranslations("roles");
  const isEdit = !!role;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    new Set(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/changes
  useEffect(() => {
    if (open) {
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
    }
  }, [open, role, cloneSource]);

  const handlePermissionToggle = (permission: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: [...selectedPermissions],
      };

      const url = isEdit ? `/api/roles/${role.id}` : "/api/roles";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? t("error"));
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSubmitting(false);
    }
  };

  const isValid = name.trim().length > 0;

  const dialogTitle = isEdit
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

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="role-name">{t("name")}</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="role-description">{t("description")}</Label>
            <Input
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Permission checkbox grid */}
          <div className="space-y-3">
            <Label>{t("permissions")}</Label>
            <div className="space-y-4 rounded border p-3">
              {Object.entries(PERMISSION_GROUPS).map(([group, perms]) => (
                <div key={group}>
                  <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
                    {t(`permissionGroups.${group}`)}
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {perms.map((perm) => {
                      const checkboxId = `perm-${perm}`;
                      // Extract action part: "accounts:read" → "read"
                      const action = perm.split(":")[1];
                      return (
                        <div
                          key={perm}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={checkboxId}
                            checked={selectedPermissions.has(perm)}
                            onCheckedChange={() => handlePermissionToggle(perm)}
                          />
                          <label htmlFor={checkboxId}>
                            {t(`permissionActions.${action}`)}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !isValid}>
              {submitting ? t("loading") : isEdit ? t("edit") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
