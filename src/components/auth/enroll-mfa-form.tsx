"use client";

import {
  AlertCircle,
  AlertTriangle,
  Copy,
  Download,
  Loader2,
  Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";

// ── Helpers ───────────────────────────────────────────────────

function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { "x-csrf-token": token } : {};
}

// ── EnrollMfaForm ─────────────────────────────────────────────

export function EnrollMfaForm() {
  const t = useTranslations("auth.mfa");
  const tTotp = useTranslations("profile.totp");
  const tRecovery = useTranslations("profile.recovery");
  const router = useRouter();

  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [error, setError] = useState("");
  const [enrolled, setEnrolled] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [codesCopied, setCodesCopied] = useState(false);

  // Auto-start TOTP setup on mount
  useEffect(() => {
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
            // Already enrolled — skip straight to completion
            setEnrolled(true);
          } else {
            setError(tTotp("setupError"));
          }
          return;
        }
        const data = await res.json();
        setSecret(data.secret);
        setUri(data.uri);
      })
      .catch(() => setError(tTotp("setupError")))
      .finally(() => setSetupLoading(false));
  }, [tTotp]);

  const completeEnrollment = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/mfa/enrollment-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
      });
      if (res.ok) {
        router.push("/");
      }
    } catch {
      // Redirect anyway — the dashboard layout will re-check
      router.push("/");
    }
  }, [router]);

  useEffect(() => {
    if (enrolled) {
      completeEnrollment();
    }
  }, [enrolled, completeEnrollment]);

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
          setError(tTotp("notAllowed"));
        } else {
          setError(tTotp("invalidCode"));
        }
        return;
      }

      const data = await res.json();
      if (data.recoveryCodes) {
        setRecoveryCodes(data.recoveryCodes);
      } else {
        setEnrolled(true);
      }
    } catch {
      setError(tTotp("setupError"));
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleCopySecret() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleCopyRecoveryCodes() {
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCodesCopied(true);
    setTimeout(() => setCodesCopied(false), 2000);
  }

  function handleDownloadRecoveryCodes() {
    const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Shield className="text-primary size-6" />
        <h1 className="text-xl font-semibold tracking-tight">
          {t("enrollMfaTitle")}
        </h1>
      </div>

      <p className="text-muted-foreground text-sm">{t("mustEnrollMfa")}</p>

      {setupLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="text-muted-foreground size-8 animate-spin" />
        </div>
      ) : recoveryCodes.length > 0 ? (
        <div className="space-y-4">
          <h2 className="font-semibold">{tRecovery("codesTitle")}</h2>
          <p className="text-muted-foreground text-sm">
            {tRecovery("codesDescription")}
          </p>

          <div className="grid grid-cols-2 gap-2">
            {recoveryCodes.map((rc) => (
              <code
                key={rc}
                className="bg-muted rounded px-3 py-2 text-center font-mono text-sm"
              >
                {rc}
              </code>
            ))}
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyRecoveryCodes}
            >
              <Copy className="mr-1 h-4 w-4" />
              {codesCopied ? tRecovery("copied") : tRecovery("copyAll")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadRecoveryCodes}
            >
              <Download className="mr-1 h-4 w-4" />
              {tRecovery("download")}
            </Button>
          </div>

          <p className="text-destructive flex items-center gap-1 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {tRecovery("saveWarning")}
          </p>

          <Button
            className="w-full"
            onClick={() => {
              setRecoveryCodes([]);
              setEnrolled(true);
            }}
          >
            {tRecovery("done")}
          </Button>
        </div>
      ) : uri ? (
        <div className="space-y-4">
          {/* QR Code */}
          <div className="flex justify-center">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG
                value={uri}
                size={200}
                aria-label={tTotp("scanQrCode")}
              />
            </div>
          </div>

          <p className="text-muted-foreground text-center text-sm">
            {tTotp("scanQrCode")}
          </p>

          {/* Manual key toggle */}
          <div className="space-y-2">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-sm underline"
              onClick={() => setShowManualKey(!showManualKey)}
            >
              {tTotp("enterManualKey")}
            </button>
            {showManualKey && (
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                  {secret}
                </code>
                <Button variant="outline" size="sm" onClick={handleCopySecret}>
                  {copied ? tTotp("copiedSecret") : tTotp("copySecret")}
                </Button>
              </div>
            )}
          </div>

          {/* Verification code input */}
          <div className="space-y-2">
            <Label htmlFor="enroll-totp-code">{tTotp("verifyCode")}</Label>
            <Input
              id="enroll-totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]*"
              placeholder={tTotp("codePlaceholder")}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                setCode(v);
              }}
              autoFocus
            />
          </div>

          {error && (
            <p
              className="text-destructive flex items-center gap-1 text-sm"
              role="alert"
            >
              <AlertCircle className="size-3.5 shrink-0" />
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={handleVerify}
            disabled={code.length !== 6 || verifyLoading}
          >
            {verifyLoading ? (
              <>
                <Loader2 className="animate-spin" />
                {tTotp("verifying")}
              </>
            ) : (
              tTotp("verify")
            )}
          </Button>
        </div>
      ) : enrolled ? (
        <div className="flex justify-center py-8">
          <Loader2 className="text-muted-foreground size-8 animate-spin" />
        </div>
      ) : error ? (
        <p
          className="text-destructive flex items-center gap-1 text-sm"
          role="alert"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
