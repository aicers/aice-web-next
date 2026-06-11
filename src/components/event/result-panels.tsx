import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Empty / pre-query / error box for the Event results region.
 *
 * Matches Detection's `StatePanel` look (`result-list.tsx`): a solid
 * `bg-card` card with a `--sidebar-border` border and muted text, and a
 * `border-destructive/40 text-destructive` tone for errors — never the
 * old dashed border. The optional `role` ("alert" for errors) is
 * preserved so screen readers still announce the error state.
 */
export function EventStatePanel({
  message,
  role,
  tone,
}: {
  message: string;
  role?: "alert";
  tone?: "destructive";
}) {
  return (
    <div
      role={role}
      className={cn(
        "bg-card rounded-lg border p-10 text-center text-sm",
        tone === "destructive"
          ? "border-destructive/40 text-destructive"
          : "border-[var(--sidebar-border)] text-muted-foreground",
      )}
    >
      {message}
    </div>
  );
}

/**
 * Populated-content container for the Event results region — the
 * raw-events table and both charts sit in one of these so the region
 * looks the same whether empty or full: the same solid border color and
 * weight, rounding, and `bg-card` background as {@link EventStatePanel}.
 * Callers pass layout extras (e.g. `overflow-x-auto`, padding) via
 * `className`.
 */
export function EventResultContainer({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-lg border border-[var(--sidebar-border)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
