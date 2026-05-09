"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
import { readCsrfToken } from "@/lib/csrf-client";
import type { TriagePolicyRow } from "@/lib/triage/policy/types";

interface FormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy?: TriagePolicyRow;
  customerId: number;
  onSuccess: () => void;
}

const EMPTY_JSON_ARRAY = "[]";

interface ServerIssue {
  path?: string;
  message?: string;
}

export function TriagePolicyFormDialog({
  open,
  onOpenChange,
  policy,
  customerId,
  onSuccess,
}: FormProps) {
  const t = useTranslations("triagePolicies");
  const isEdit = !!policy;

  const [name, setName] = useState(policy?.name ?? "");
  const [packetAttrText, setPacketAttrText] = useState(EMPTY_JSON_ARRAY);
  const [confidenceText, setConfidenceText] = useState(EMPTY_JSON_ARRAY);
  const [responseText, setResponseText] = useState(EMPTY_JSON_ARRAY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ServerIssue[]>([]);

  useEffect(() => {
    if (open) {
      setName(policy?.name ?? "");
      setPacketAttrText(JSON.stringify(policy?.packet_attr ?? [], null, 2));
      setConfidenceText(JSON.stringify(policy?.confidence ?? [], null, 2));
      setResponseText(JSON.stringify(policy?.response ?? [], null, 2));
      setError(null);
      setIssues([]);
    }
  }, [open, policy]);

  const parseJsonArray = (
    raw: string,
    field: string,
  ): { ok: true; value: unknown[] } | { ok: false; error: string } => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: t("notAnArray", { field }) };
      }
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: t("invalidJson", { field }) };
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setIssues([]);

    const packetAttr = parseJsonArray(packetAttrText, t("packetAttr"));
    if (!packetAttr.ok) {
      setError(packetAttr.error);
      setSubmitting(false);
      return;
    }
    const confidence = parseJsonArray(confidenceText, t("confidence"));
    if (!confidence.ok) {
      setError(confidence.error);
      setSubmitting(false);
      return;
    }
    const response = parseJsonArray(responseText, t("response"));
    if (!response.ok) {
      setError(response.error);
      setSubmitting(false);
      return;
    }

    const payload = {
      name: name.trim(),
      packet_attr: packetAttr.value,
      confidence: confidence.value,
      response: response.value,
    };

    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      const url = isEdit
        ? `/api/triage/policies/${policy.id}?customer_id=${customerId}`
        : `/api/triage/policies?customer_id=${customerId}`;
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json();
        if (Array.isArray(body.details)) {
          setIssues(body.details as ServerIssue[]);
        }
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void submit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("edit") : t("create")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="triage-policy-name">{t("name")}</Label>
            <Input
              id="triage-policy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="triage-policy-packet-attr">{t("packetAttr")}</Label>
            <textarea
              id="triage-policy-packet-attr"
              value={packetAttrText}
              onChange={(e) => setPacketAttrText(e.target.value)}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-32 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-1 focus-visible:outline-none"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {t("packetAttrHelp")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="triage-policy-confidence">{t("confidence")}</Label>
            <textarea
              id="triage-policy-confidence"
              value={confidenceText}
              onChange={(e) => setConfidenceText(e.target.value)}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-24 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-1 focus-visible:outline-none"
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="triage-policy-response">{t("response")}</Label>
            <textarea
              id="triage-policy-response"
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-24 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-1 focus-visible:outline-none"
              spellCheck={false}
            />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
          {issues.length > 0 && (
            <ul className="text-destructive list-disc space-y-1 pl-4 text-xs">
              {issues.map((iss, idx) => {
                const path = iss.path ?? "";
                const key = path ? `${path}-${idx}` : `issue-${idx}`;
                return (
                  <li key={key}>
                    {path ? `${path}: ` : ""}
                    {iss.message ?? ""}
                  </li>
                );
              })}
            </ul>
          )}

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
  );
}
