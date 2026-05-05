"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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

interface Customer {
  id: number;
  name: string;
  description: string | null;
  external_key: string | null;
}

interface CustomerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: Customer;
  onSuccess: () => void;
}

// Variants for the effect-warning modal triggered when an edit changes
// the effective `external_key` value (#438).
type ExternalKeyChangeVariant = "set" | "clear";

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Normalize an `external_key` form input to the value that would
 * actually be stored after server-side normalization. Mirrors
 * `src/lib/customers/external-key.ts` rules: trim, then empty becomes
 * NULL.
 */
function normalizeExternalKeyInput(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ── Component ───────────────────────────────────────────────────

export function CustomerFormDialog({
  open,
  onOpenChange,
  customer,
  onSuccess,
}: CustomerFormDialogProps) {
  const t = useTranslations("customers");
  const isEdit = !!customer;

  const [name, setName] = useState(customer?.name ?? "");
  const [description, setDescription] = useState(customer?.description ?? "");
  const [externalKey, setExternalKey] = useState(customer?.external_key ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingWarning, setPendingWarning] =
    useState<ExternalKeyChangeVariant | null>(null);

  // Resync form state from the current `customer` prop whenever the
  // dialog opens. The component is mounted once by the parent table and
  // reused across opens, so without this effect the initial `useState`
  // values from the very first render would persist (e.g. an empty
  // `name` after the first edit), leaving the submit button disabled.
  useEffect(() => {
    if (open) {
      setName(customer?.name ?? "");
      setDescription(customer?.description ?? "");
      setExternalKey(customer?.external_key ?? "");
      setError(null);
      setPendingWarning(null);
    }
  }, [open, customer]);

  const submit = async () => {
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

      const url = isEdit ? `/api/customers/${customer.id}` : "/api/customers";
      const method = isEdit ? "PATCH" : "POST";

      // For external_key we send `null` to clear, the trimmed string
      // when set, or omit the field when it was untouched on edit.
      const normalizedExternalKey = normalizeExternalKeyInput(externalKey);
      const externalKeyChanged =
        !isEdit || normalizedExternalKey !== (customer?.external_key ?? null);

      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || undefined,
      };
      if (externalKeyChanged) {
        body.external_key = normalizedExternalKey;
      }

      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.json();
        if (res.status === 409 && responseBody.field === "external_key") {
          throw new Error(t("externalKeyConflict"));
        }
        throw new Error(responseBody.error ?? t("error"));
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSubmitting(false);
      setPendingWarning(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Determine whether the effective `external_key` is changing on
    // edit. The warning fires for any change to the effective value:
    //   - NULL → value (set)
    //   - value → different value (change)
    //   - non-NULL → NULL (clear)
    // A no-op (NULL → NULL via empty input on an already-NULL row)
    // does not trigger the warning.
    if (isEdit) {
      const previous = customer?.external_key ?? null;
      const next = normalizeExternalKeyInput(externalKey);
      if (next !== previous) {
        setPendingWarning(next === null ? "clear" : "set");
        return;
      }
    }

    void submit();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName(customer?.name ?? "");
      setDescription(customer?.description ?? "");
      setExternalKey(customer?.external_key ?? "");
      setError(null);
      setPendingWarning(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? t("edit") : t("create")}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customer-name">{t("name")}</Label>
              <Input
                id="customer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="customer-description">{t("description")}</Label>
              <Input
                id="customer-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="customer-external-key">{t("externalKey")}</Label>
              <Input
                id="customer-external-key"
                value={externalKey}
                onChange={(e) => setExternalKey(e.target.value)}
                placeholder={t("externalKeyPlaceholder")}
                maxLength={256}
                aria-describedby="customer-external-key-help"
              />
              <p
                id="customer-external-key-help"
                className="text-muted-foreground text-xs leading-relaxed"
              >
                {t("externalKeyHelp")}{" "}
                <a
                  href={t("externalKeyHelpLinkUrl")}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline"
                >
                  {t("externalKeyHelpLink")}
                </a>
              </p>
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={submitting}>
                  {t("cancel")}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={submitting || !name.trim()}>
                {submitting ? t("loading") : isEdit ? t("edit") : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingWarning !== null}
        // Non-dismissable: the modal is consumed only via Cancel or
        // Continue, never by an outside click or escape press (#438).
        // Radix AlertDialog already blocks pointer-down-outside; we
        // additionally swallow Escape so the operator can't dismiss
        // the warning without an explicit choice.
        onOpenChange={() => {}}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event: KeyboardEvent) => {
            event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingWarning === "clear"
                ? t("externalKeyClearTitle")
                : t("externalKeyChangeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingWarning === "clear"
                ? t("externalKeyClearBody")
                : t("externalKeyChangeBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setPendingWarning(null)}
              disabled={submitting}
            >
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void submit();
              }}
              disabled={submitting}
            >
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
