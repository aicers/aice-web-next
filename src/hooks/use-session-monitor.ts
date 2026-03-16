"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/navigation";

// ── Constants ──────────────────────────────────────────────────

const TOKEN_EXP_COOKIE = "token_exp";
const TOKEN_TTL_COOKIE = "token_ttl";

// ── Cookie helper ──────────────────────────────────────────────

interface SessionTokenMeta {
  exp: number;
  ttl: number;
}

function readCookieNumber(name: string): number | null {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;

  const value = Number(match.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readSessionTokenMeta(): SessionTokenMeta | null {
  const exp = readCookieNumber(TOKEN_EXP_COOKIE);
  const ttl = readCookieNumber(TOKEN_TTL_COOKIE);
  if (exp === null || ttl === null) {
    return null;
  }

  return { exp, ttl };
}

// ── Hook ───────────────────────────────────────────────────────

interface SessionMonitorState {
  /** Seconds remaining until the JWT expires. */
  remainingSeconds: number;
  /** Whether the session extension dialog should be shown. */
  showDialog: boolean;
  /** Dismiss the dialog (e.g. after a successful extend). */
  dismiss: () => void;
}

export function useSessionMonitor(): SessionMonitorState {
  const router = useRouter();
  const [remainingSeconds, setRemainingSeconds] = useState(() => {
    if (typeof document !== "undefined") {
      const token = readSessionTokenMeta();
      if (token !== null) {
        return Math.max(0, token.exp - Math.floor(Date.now() / 1000));
      }
    }
    return 0;
  });
  const [showDialog, setShowDialog] = useState(false);
  const dismissedExpRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setShowDialog(false);
    dismissedExpRef.current = readSessionTokenMeta()?.exp ?? null;
  }, []);

  useEffect(() => {
    const tick = () => {
      const token = readSessionTokenMeta();
      if (token === null) {
        setShowDialog(false);
        setRemainingSeconds(0);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const remaining = token.exp - now;

      setRemainingSeconds(Math.max(0, remaining));

      if (remaining <= 0) {
        // JWT has expired — redirect to sign-in
        setShowDialog(false);
        router.push("/sign-in?reason=session-ended");
        return;
      }

      if (
        dismissedExpRef.current !== null &&
        token.exp !== dismissedExpRef.current
      ) {
        dismissedExpRef.current = null;
      }

      const dialogThreshold = token.ttl / 5;
      if (
        remaining <= dialogThreshold &&
        dismissedExpRef.current !== token.exp
      ) {
        setShowDialog(true);
      } else {
        setShowDialog(false);
      }
    };

    // Run immediately, then every second
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [router]);

  return { remainingSeconds, showDialog, dismiss };
}
