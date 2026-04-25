"use client";

/**
 * Pivot feedback toast (Phase Detection-12).
 *
 * The Detection page does not pull in a toast library — every other
 * surface uses inline alert banners (see `DownloadErrorBanner` in
 * `result-list.tsx`) or modal sheets. The pivot feature needs a
 * lightweight transient notification for two cases:
 *
 *   - "Already filtered by X" — the click would only re-narrow the
 *     active tab.
 *   - "Tab cap reached" — the wrapper would otherwise have created
 *     the 9th concurrent tab.
 *
 * Rendered as a small bottom-right ARIA-live region that auto-dismisses
 * after a fixed timeout. The host (`detection-tabs-shell`) owns the
 * timer + "current message" state so the toast is decoupled from the
 * pivot decision logic.
 */

import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export interface PivotToastProps {
  message: string | null;
  onDismiss: () => void;
  dismissLabel: string;
  /** Auto-dismiss timeout in ms. */
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 4000;

export function PivotToast({
  message,
  onDismiss,
  dismissLabel,
  durationMs = DEFAULT_DURATION_MS,
}: PivotToastProps) {
  useEffect(() => {
    if (!message) return;
    const handle = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(handle);
  }, [message, onDismiss, durationMs]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-foreground text-background pointer-events-auto fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-md px-3 py-2 text-sm shadow-lg"
      data-slot="detection-pivot-toast"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="text-background hover:bg-background/20 hover:text-background size-5 shrink-0"
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
