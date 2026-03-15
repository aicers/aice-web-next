"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/navigation";

// ── Constants ──────────────────────────────────────────────────

/**
 * Show the session extension dialog when the remaining JWT lifetime
 * drops to 3 minutes or less.
 *
 * This is a fixed absolute threshold — simpler than a fraction of the
 * total TTL and requires no additional signal from the server.
 */
const DIALOG_THRESHOLD_SECONDS = 180;

const TOKEN_EXP_COOKIE = "token_exp";

// ── Cookie helper ──────────────────────────────────────────────

function readTokenExp(): number | null {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${TOKEN_EXP_COOKIE}=`));
  if (!match) return null;
  const value = Number(match.split("=")[1]);
  return Number.isNaN(value) ? null : value;
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
    // Derive initial remaining time from the cookie if available,
    // otherwise fall back to a safe non-zero value.
    if (typeof document !== "undefined") {
      const exp = readTokenExp();
      if (exp !== null) {
        return Math.max(0, exp - Math.floor(Date.now() / 1000));
      }
    }
    return DIALOG_THRESHOLD_SECONDS + 1;
  });
  const [showDialog, setShowDialog] = useState(false);
  const dismissedExpRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setShowDialog(false);
    // Remember which exp we dismissed for, so we don't re-show
    // until the cookie updates (i.e. rotation happens).
    dismissedExpRef.current = readTokenExp();
  }, []);

  useEffect(() => {
    const tick = () => {
      const exp = readTokenExp();
      if (exp === null) {
        // No token_exp cookie — user is not authenticated or cookie
        // was cleared.  Nothing to monitor.
        setShowDialog(false);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const remaining = exp - now;

      setRemainingSeconds(Math.max(0, remaining));

      if (remaining <= 0) {
        // JWT has expired — redirect to sign-in
        setShowDialog(false);
        router.push("/sign-in?reason=session-ended");
        return;
      }

      // If the token_exp changed (rotation happened), dismiss any
      // previously shown dialog.
      if (dismissedExpRef.current !== null && exp !== dismissedExpRef.current) {
        dismissedExpRef.current = null;
      }

      // Show dialog when remaining ≤ threshold and we haven't
      // dismissed for this particular exp value.
      if (
        remaining <= DIALOG_THRESHOLD_SECONDS &&
        dismissedExpRef.current !== exp
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
