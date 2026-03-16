"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

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
import { useSessionMonitor } from "@/hooks/use-session-monitor";
import { useRouter } from "@/i18n/navigation";

// ── Helpers ────────────────────────────────────────────────────

/** Read the CSRF token from the cookie (non-httpOnly). */
export function readCsrfToken(): string | null {
  // Production uses "__Host-csrf", development uses "csrf"
  for (const name of ["__Host-csrf", "csrf"]) {
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${name}=`));
    if (match) return match.split("=")[1];
  }
  return null;
}

/** Delete session monitor cookies client-side to prevent stale warnings. */
function clearSessionMonitorCookies(): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not universally supported
  document.cookie = "token_exp=; path=/; max-age=0";
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not universally supported
  document.cookie = "token_ttl=; path=/; max-age=0";
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Component ──────────────────────────────────────────────────

export function SessionExtensionDialog() {
  const t = useTranslations();
  const router = useRouter();
  const { remainingSeconds, showDialog, dismiss } = useSessionMonitor();

  const [extending, setExtending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        dismiss();
      } else {
        // Token already expired or invalid — redirect to sign-in
        clearSessionMonitorCookies();
        router.push("/sign-in?reason=session-ended");
      }
    } catch {
      clearSessionMonitorCookies();
      router.push("/sign-in?reason=session-ended");
    } finally {
      setExtending(false);
    }
  }, [dismiss, router]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      const csrfToken = readCsrfToken();
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
      });
    } catch {
      // Best-effort sign-out; redirect regardless
    } finally {
      clearSessionMonitorCookies();
      router.push("/sign-in?reason=signed-out");
    }
  }, [router]);

  return (
    <AlertDialog open={showDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("auth.sessionExpiring")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("auth.sessionExpiringDescription", {
              seconds: remainingSeconds,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-center text-2xl font-mono font-semibold tabular-nums">
          {formatCountdown(remainingSeconds)}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={handleSignOut}
            disabled={signingOut || extending}
          >
            {signingOut ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("common.signOut")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleExtend}
            disabled={extending || signingOut}
          >
            {extending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("auth.extendSession")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
