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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Types ───────────────────────────────────────────────────────

interface Account {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_name: string;
  status: string;
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

interface AccountFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: Account;
  roles: Role[];
  customers: Customer[];
  onSuccess: () => void;
}

// ── Component ───────────────────────────────────────────────────

export function AccountFormDialog({
  open,
  onOpenChange,
  account,
  roles,
  customers,
  onSuccess,
}: AccountFormDialogProps) {
  const t = useTranslations("accounts");
  const isEdit = !!account;

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/changes
  useEffect(() => {
    if (open) {
      if (account) {
        setUsername(account.username);
        setDisplayName(account.display_name);
        setEmail(account.email ?? "");
        setPhone(account.phone ?? "");
        const matchRole = roles.find((r) => r.name === account.role_name);
        setRoleId(matchRole ? String(matchRole.id) : "");
        setSelectedCustomerIds([]);
      } else {
        setUsername("");
        setDisplayName("");
        setPassword("");
        setRoleId("");
        setEmail("");
        setPhone("");
        setSelectedCustomerIds([]);
      }
      setError(null);
    }
  }, [open, account, roles]);

  const selectedRole = roles.find((r) => String(r.id) === roleId);
  const hasSingleCustomerLimit = selectedRole?.max_customer_assignments === 1;
  const requiresCustomerAssignment =
    selectedRole?.requires_customer_assignment ?? false;

  const handleCustomerToggle = (customerId: number) => {
    setSelectedCustomerIds((prev) => {
      if (prev.includes(customerId)) {
        return prev.filter((id) => id !== customerId);
      }
      if (hasSingleCustomerLimit) {
        return [customerId];
      }
      return [...prev, customerId];
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

      if (isEdit) {
        // PATCH
        const res = await fetch(`/api/accounts/${account.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            displayName: displayName.trim(),
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? t("error"));
        }
      } else {
        // POST
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: username.trim(),
            displayName: displayName.trim(),
            password,
            roleId: Number(roleId),
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            customerIds:
              selectedCustomerIds.length > 0 ? selectedCustomerIds : undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? t("error"));
        }
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSubmitting(false);
    }
  };

  const isValid = isEdit
    ? displayName.trim().length > 0
    : username.trim().length > 0 &&
      displayName.trim().length > 0 &&
      password.length > 0 &&
      roleId.length > 0 &&
      (!requiresCustomerAssignment || selectedCustomerIds.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("edit") : t("create")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Username (create only) */}
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="account-username">{t("username")}</Label>
              <Input
                id="account-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          )}

          {/* Display Name */}
          <div className="space-y-2">
            <Label htmlFor="account-displayName">{t("displayName")}</Label>
            <Input
              id="account-displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>

          {/* Password (create only) */}
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="account-password">{t("password")}</Label>
              <Input
                id="account-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}

          {/* Role (create only) */}
          {!isEdit && (
            <div className="space-y-2">
              <Label>{t("role")}</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("role")} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={String(role.id)}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="account-email">{t("email")}</Label>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {/* Phone */}
          <div className="space-y-2">
            <Label htmlFor="account-phone">{t("phone")}</Label>
            <Input
              id="account-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          {!isEdit &&
            selectedRole &&
            requiresCustomerAssignment &&
            customers.length > 0 && (
              <div className="space-y-2">
                <Label>
                  {t("customers")}
                  {hasSingleCustomerLimit && (
                    <span className="text-muted-foreground ml-1 text-xs">
                      (max 1)
                    </span>
                  )}
                </Label>
                <div className="max-h-40 space-y-2 overflow-y-auto rounded border p-3">
                  {customers.map((customer) => {
                    const checkboxId = `customer-${customer.id}`;
                    return (
                      <div
                        key={customer.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={selectedCustomerIds.includes(customer.id)}
                          onCheckedChange={() =>
                            handleCustomerToggle(customer.id)
                          }
                        />
                        <label htmlFor={checkboxId}>{customer.name}</label>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
