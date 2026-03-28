"use client";

import { useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import {
  AlertDialog,
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
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
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

// ── TotpCard (exported) ─────────────────────────────────────

export function TotpCard() {
  const t = useTranslations("profile.totp");

  const [enrolled, setEnrolled] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const fetchStatus = useCallback(() => {
    setFetchError(false);
    fetch("/api/auth/mfa/totp/status")
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      })
      .then((data) => {
        setEnrolled(data.enrolled);
        setAllowed(data.allowed);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  function handleEnrollComplete() {
    setEnrollOpen(false);
    fetchStatus();
  }

  function handleDisableComplete() {
    setDisableOpen(false);
    fetchStatus();
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
              {t("setupError")}
            </p>
          ) : (
            <Badge variant={enrolled ? "default" : "secondary"}>
              {enrolled ? t("enabled") : t("disabled")}
            </Badge>
          )}
        </CardContent>
        {!fetchError && (
          <CardFooter>
            {enrolled ? (
              <Button variant="outline" onClick={() => setDisableOpen(true)}>
                {t("disable")}
              </Button>
            ) : (
              <div className="space-y-2">
                <Button onClick={() => setEnrollOpen(true)} disabled={!allowed}>
                  {t("enable")}
                </Button>
                {!allowed && (
                  <p className="text-muted-foreground text-sm">
                    {t("notAllowed")}
                  </p>
                )}
              </div>
            )}
          </CardFooter>
        )}
      </Card>

      <TotpEnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        onComplete={handleEnrollComplete}
      />

      <TotpDisableDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        onComplete={handleDisableComplete}
      />
    </>
  );
}

// ── TotpEnrollDialog ────────────────────────────────────────

function TotpEnrollDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.totp");

  const [step, setStep] = useState<"verify" | "success">("verify");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [error, setError] = useState("");

  // Call setup API when dialog opens
  useEffect(() => {
    if (!open) {
      // Reset state when dialog closes
      setStep("verify");
      setSecret("");
      setUri("");
      setCode("");
      setShowManualKey(false);
      setCopied(false);
      setSetupLoading(false);
      setVerifyLoading(false);
      setError("");
      return;
    }

    setSetupLoading(true);
    setError("");

    fetch("/api/auth/mfa/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (body?.code === "TOTP_ALREADY_ENROLLED") {
            setError(t("alreadyEnrolled"));
          } else if (body?.code === "TOTP_NOT_ALLOWED") {
            setError(t("notAllowed"));
          } else {
            setError(t("setupError"));
          }
          return;
        }
        const data = await res.json();
        setSecret(data.secret);
        setUri(data.uri);
      })
      .catch(() => setError(t("setupError")))
      .finally(() => setSetupLoading(false));
  }, [open, t]);

  async function handleVerify() {
    setVerifyLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/mfa/totp/verify-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.code === "TOTP_NOT_ALLOWED") {
          setError(t("notAllowed"));
        } else if (body?.code === "TOTP_NOT_FOUND") {
          setError(t("setupError"));
        } else {
          setError(t("invalidCode"));
        }
        return;
      }

      setStep("success");
    } catch {
      setError(t("setupError"));
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleCopySecret() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (step === "success") {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onComplete();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("setupCompleteTitle")}</DialogTitle>
            <DialogDescription>{t("setupComplete")}</DialogDescription>
          </DialogHeader>
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
          <DialogTitle>{t("setupTitle")}</DialogTitle>
          <DialogDescription>{t("scanQrCode")}</DialogDescription>
        </DialogHeader>

        {setupLoading ? (
          <div className="flex justify-center py-8">
            <div className="border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
          </div>
        ) : uri ? (
          <div className="space-y-4">
            {/* QR Code */}
            <div className="flex justify-center">
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG
                  value={uri}
                  size={200}
                  aria-label={t("scanQrCode")}
                />
              </div>
            </div>

            {/* Manual key toggle */}
            <div className="space-y-2">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-sm underline"
                onClick={() => setShowManualKey(!showManualKey)}
              >
                {t("enterManualKey")}
              </button>
              {showManualKey && (
                <div className="flex items-center gap-2">
                  <code
                    className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all"
                    data-testid="totp-secret"
                  >
                    {secret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopySecret}
                  >
                    {copied ? t("copiedSecret") : t("copySecret")}
                  </Button>
                </div>
              )}
            </div>

            {/* Verification code input */}
            <div className="space-y-2">
              <Label htmlFor="totp-verify-code">{t("verifyCode")}</Label>
              <Input
                id="totp-verify-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                placeholder={t("codePlaceholder")}
                value={code}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  setCode(v);
                }}
              />
            </div>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button
            onClick={handleVerify}
            disabled={code.length !== 6 || verifyLoading || !uri}
          >
            {verifyLoading ? t("verifying") : t("verify")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── TotpDisableDialog ───────────────────────────────────────

function TotpDisableDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.totp");

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setCode("");
      setLoading(false);
      setError("");
    }
  }, [open]);

  async function handleDisable() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/mfa/totp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.code === "TOTP_NOT_FOUND") {
          onComplete();
        } else {
          setError(t("invalidCode"));
        }
        return;
      }

      onComplete();
    } catch {
      setError(t("disableError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmDisableTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirmDisableDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="totp-disable-code">{t("verifyCode")}</Label>
          <Input
            id="totp-disable-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]*"
            placeholder={t("codePlaceholder")}
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "");
              setCode(v);
            }}
          />
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleDisable}
            disabled={code.length !== 6 || loading}
          >
            {loading ? t("disabling") : t("disable")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
