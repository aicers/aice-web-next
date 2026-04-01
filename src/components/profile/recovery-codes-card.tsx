"use client";

import { AlertTriangle, Copy, Download, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Helpers ───────────────────────────────────────────────────

function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { "x-csrf-token": token } : {};
}

// ── RecoveryCodesCard (exported) ────────────────────────────

export function RecoveryCodesCard() {
  const t = useTranslations("profile.recovery");

  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const fetchCount = useCallback(() => {
    setFetchError(false);
    fetch("/api/auth/mfa/recovery/count")
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      })
      .then((data) => {
        setRemaining(data.remaining);
        setTotal(data.total);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  function handleGenerateComplete() {
    setGenerateOpen(false);
    fetchCount();
  }

  if (loading) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {fetchError ? (
            <p className="text-destructive text-sm" role="alert">
              {t("fetchError")}
            </p>
          ) : total === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noCodes")}</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm">
                {t("remaining", { remaining, total })}
              </span>
              {remaining <= 3 && (
                <Badge variant="destructive">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {t("low")}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
        {!fetchError && (
          <CardFooter>
            <Button onClick={() => setGenerateOpen(true)}>
              {total === 0 ? t("generate") : t("regenerate")}
            </Button>
          </CardFooter>
        )}
      </Card>

      <GenerateCodesDialog
        open={generateOpen}
        onOpenChange={(isOpen) => {
          setGenerateOpen(isOpen);
          if (!isOpen) fetchCount();
        }}
        onComplete={handleGenerateComplete}
      />
    </>
  );
}

// ── GenerateCodesDialog ─────────────────────────────────────

function GenerateCodesDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.recovery");

  const [step, setStep] = useState<"password" | "codes">("password");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep("password");
      setPassword("");
      setCodes([]);
      setGenerateLoading(false);
      setError("");
      setCopied(false);
    }
  }, [open]);

  async function handleGenerate() {
    setGenerateLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/mfa/recovery/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.code === "INVALID_PASSWORD") {
          setError(t("invalidPassword"));
        } else {
          setError(t("generateError"));
        }
        return;
      }

      const data = await res.json();
      setCodes(data.codes);
      setStep("codes");
    } catch {
      setError(t("generateError"));
    } finally {
      setGenerateLoading(false);
    }
  }

  async function handleCopyAll() {
    await navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const blob = new Blob([codes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (step === "codes") {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onComplete();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("codesTitle")}</DialogTitle>
            <DialogDescription>{t("codesDescription")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {codes.map((code) => (
                <code
                  key={code}
                  className="bg-muted rounded px-3 py-2 text-center font-mono text-sm"
                >
                  {code}
                </code>
              ))}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopyAll}>
                <Copy className="mr-1 h-4 w-4" />
                {copied ? t("copied") : t("copyAll")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-1 h-4 w-4" />
                {t("download")}
              </Button>
            </div>

            <p className="text-destructive flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="h-4 w-4" />
              {t("saveWarning")}
            </p>
          </div>

          <DialogFooter>
            <Button onClick={onComplete}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("generateTitle")}</DialogTitle>
          <DialogDescription>{t("generateDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="recovery-password">{t("password")}</Label>
            <Input
              id="recovery-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={!password || generateLoading}
          >
            {generateLoading && (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            )}
            {generateLoading ? t("generating") : t("generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
