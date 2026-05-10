"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readCsrfToken } from "@/lib/csrf-client";
import { reduceDomainPatternToSuffix } from "@/lib/triage/exclusion/suffix-reducer";

interface FormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "customer";
  customerId?: number;
  onSuccess: () => void;
}

type Kind = "ipAddress" | "hostname" | "uri" | "domain";

const KINDS: Kind[] = ["ipAddress", "hostname", "uri", "domain"];

export function TriageExclusionFormDialog({
  open,
  onOpenChange,
  scope,
  customerId,
  onSuccess,
}: FormProps) {
  const t = useTranslations("triageExclusions");

  const [kind, setKind] = useState<Kind>("ipAddress");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind("ipAddress");
      setValue("");
      setNote("");
      setError(null);
    }
  }, [open]);

  const domainPreview = useMemo(() => {
    if (kind !== "domain" || value.trim().length === 0) return null;
    try {
      return reduceDomainPatternToSuffix(value.trim());
    } catch {
      return null;
    }
  }, [kind, value]);

  const helperText = (() => {
    switch (kind) {
      case "ipAddress":
        return t("valueIpHelper");
      case "hostname":
        return t("valueHostnameHelper");
      case "uri":
        return t("valueUriHelper");
      case "domain":
        return t("valueDomainHelper");
    }
  })();

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      const url =
        scope === "global"
          ? "/api/triage/exclusions/global"
          : `/api/triage/exclusions?customer_id=${customerId}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind, value, note: note.trim() || null }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? t("error"));
      }
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("create")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="exclusion-kind">{t("kind")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger id="exclusion-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(
                      k === "ipAddress"
                        ? "kindIpAddress"
                        : k === "hostname"
                          ? "kindHostname"
                          : k === "uri"
                            ? "kindUri"
                            : "kindDomain",
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exclusion-value">{t("value")}</Label>
            <Input
              id="exclusion-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{helperText}</p>
            {kind === "domain" && value.trim().length > 0 && (
              <p className="text-xs">
                {domainPreview === null
                  ? t("domainPreviewFullRegex")
                  : domainPreview.exact
                    ? t("domainPreviewExact", { host: domainPreview.value })
                    : t("domainPreviewSuffix", {
                        suffix: domainPreview.value,
                      })}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="exclusion-note">{t("note")}</Label>
            <Input
              id="exclusion-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={submitting}>
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button onClick={() => void submit()} disabled={submitting}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
