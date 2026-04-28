"use client";

import { useTranslations } from "next-intl";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ServiceStatus,
  ServiceStatusReason,
} from "@/lib/node/service-status";
import { cn } from "@/lib/utils";

/**
 * Visual orb + short label + diagnostic tooltip for one per-service
 * cell on the Status tab and one card on the detail page.
 *
 * Token mapping (Phase Node-7, #313 — pulled from the existing palette
 * used by `node-status-table.tsx` ProgressBar / ManagerBadge):
 *   on   → bg-emerald-500
 *   idle → bg-amber-500
 *   off  → bg-muted-foreground
 *
 * The orb is an `aria-hidden` visual cue — the short text label
 * carries the screen-reader signal. The tooltip exposes the raw
 * underlying signal (agent storedStatus, external probe outcome, dead-
 * node override, or absent service) so an operator can diagnose the
 * cell without opening the detail page.
 */

const ORB_CLASS: Record<ServiceStatus, string> = {
  on: "bg-emerald-500",
  off: "bg-muted-foreground",
  idle: "bg-amber-500",
};

interface ServiceStatusBadgeProps {
  status: ServiceStatus;
  reason: ServiceStatusReason;
  /** Test id on the wrapper so e2e specs can target the cell. */
  testId?: string;
  /** Render the short text label alongside the orb. Default true. */
  showLabel?: boolean;
  /** Apply additional Tailwind classes to the wrapper. */
  className?: string;
}

export function ServiceStatusBadge({
  status,
  reason,
  testId,
  showLabel = true,
  className,
}: ServiceStatusBadgeProps) {
  const t = useTranslations("nodes.status.serviceStatus");
  const label = t(`labels.${status}`);
  const tooltipText = reasonTooltip(t, reason);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-xs",
              className,
            )}
            data-testid={testId}
            data-status={status}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                ORB_CLASS[status],
              )}
            />
            {showLabel && <span>{label}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function reasonTooltip(
  t: ReturnType<typeof useTranslations>,
  reason: ServiceStatusReason,
): string {
  switch (reason.kind) {
    case "agent":
      return t(`tooltips.agent.${reason.storedStatus}`);
    case "external":
      return t(`tooltips.external.${reason.outcome}`);
    case "deadNode":
      return t("tooltips.deadNode");
    case "absent":
      return t("tooltips.absent");
  }
}
