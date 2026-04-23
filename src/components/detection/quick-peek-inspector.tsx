"use client";

import { X } from "lucide-react";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  levelBadgeVariant,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Event } from "@/lib/detection/types";
import { isEventAddressable } from "@/lib/events/event-locator";
import { formatDateTime } from "@/lib/format-date";

export interface QuickPeekInspectorLabels {
  title: string;
  description: string;
  placeholder: string;
  openInvestigation: string;
  close: string;
}

interface QuickPeekInspectorProps {
  event: Event | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenInvestigation: (event: Event) => void;
  labels: QuickPeekInspectorLabels;
  /**
   * When true, render the inspector as an inline pane that shares
   * horizontal space with the result list (wide-viewport layout
   * contract from Phase Detection-9). When false, render it as the
   * right-side Sheet overlay so narrow viewports keep the list at
   * full width.
   */
  inline?: boolean;
}

/**
 * Quick peek inspector shell.
 *
 * Phase Detection-9 owns the act of opening the inspector on row
 * click plus the list ↔ inspector width split at wide viewports;
 * the inspector's *contents* land in Phase Detection-18.
 */
export function QuickPeekInspector({
  event,
  open,
  onOpenChange,
  onOpenInvestigation,
  labels,
  inline = false,
}: QuickPeekInspectorProps) {
  if (inline) {
    if (!open || !event) return null;
    return (
      <aside
        role="dialog"
        aria-label={labels.title}
        className="bg-background flex w-[22rem] shrink-0 flex-col gap-4 rounded-lg border border-[var(--sidebar-border)] shadow-sm"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--sidebar-border)] p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-foreground text-sm font-semibold">
              {labels.title}
            </h2>
            <p className="text-muted-foreground text-xs">
              {labels.description}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            aria-label={labels.close}
            className="text-muted-foreground hover:text-foreground h-7 px-2"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>
        <InspectorBody
          event={event}
          labels={labels}
          onOpenInvestigation={onOpenInvestigation}
        />
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        closeLabel={labels.close}
        className="sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{labels.title}</SheetTitle>
          <SheetDescription>{labels.description}</SheetDescription>
        </SheetHeader>
        {event ? (
          <InspectorBody
            event={event}
            labels={labels}
            onOpenInvestigation={onOpenInvestigation}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function InspectorBody({
  event,
  labels,
  onOpenInvestigation,
}: {
  event: Event;
  labels: QuickPeekInspectorLabels;
  onOpenInvestigation: (event: Event) => void;
}) {
  const kind = EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={levelBadgeVariant(event.level)} className="uppercase">
          {event.level}
        </Badge>
        <time
          dateTime={event.time}
          className="text-muted-foreground font-mono text-xs"
        >
          {formatDateTime(event.time)}
        </time>
        <span className="text-foreground text-sm font-medium">{kind}</span>
      </div>
      <p className="text-muted-foreground text-xs" title={event.sensor}>
        {event.sensor}
      </p>
      <p className="text-muted-foreground border-t border-[var(--sidebar-border)] pt-4 text-xs">
        {labels.placeholder}
      </p>
      {isEventAddressable(event) ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenInvestigation(event)}
          className="self-start"
        >
          {labels.openInvestigation}
        </Button>
      ) : null}
    </div>
  );
}
