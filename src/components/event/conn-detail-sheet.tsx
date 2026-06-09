"use client";

import { useTranslations } from "next-intl";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type ConnRawEvent,
  formatCount,
  formatDurationNs,
  formatEndpoint,
  protoLabel,
} from "@/lib/event";

/**
 * Row-detail view for a single Conn raw event. Renders every field in
 * a definition list — the table shows a compact subset, this shows the
 * full record. Controlled: `event` non-null opens the sheet; closing it
 * raises `onClose`.
 */
export function ConnDetailSheet({
  event,
  locale,
  onClose,
}: {
  event: ConnRawEvent | null;
  locale: string;
  onClose: () => void;
}) {
  const t = useTranslations("event.detail");

  const rows: Array<{ label: string; value: string }> = event
    ? [
        { label: t("time"), value: event.time },
        { label: t("startTime"), value: event.startTime },
        { label: t("duration"), value: formatDurationNs(event.duration) },
        { label: t("proto"), value: protoLabel(event.proto) },
        { label: t("connState"), value: event.connState },
        { label: t("service"), value: event.service || "—" },
        { label: t("origAddr"), value: event.origAddr },
        { label: t("origPort"), value: String(event.origPort) },
        { label: t("respAddr"), value: event.respAddr },
        { label: t("respPort"), value: String(event.respPort) },
        { label: t("origBytes"), value: formatCount(event.origBytes, locale) },
        { label: t("respBytes"), value: formatCount(event.respBytes, locale) },
        { label: t("origPkts"), value: formatCount(event.origPkts, locale) },
        { label: t("respPkts"), value: formatCount(event.respPkts, locale) },
        {
          label: t("origL2Bytes"),
          value: formatCount(event.origL2Bytes, locale),
        },
        {
          label: t("respL2Bytes"),
          value: formatCount(event.respL2Bytes, locale),
        },
      ]
    : [];

  return (
    <Sheet
      open={event !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          {event ? (
            <SheetDescription>
              {formatEndpoint(event.origAddr, event.origPort)} →{" "}
              {formatEndpoint(event.respAddr, event.respPort)}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        <dl className="grid grid-cols-1 gap-px px-4 pb-6">
          {rows.map((row) => (
            <div key={row.label} className="bg-card flex flex-col gap-0.5 py-2">
              <dt className="text-muted-foreground text-xs font-medium">
                {row.label}
              </dt>
              <dd className="break-all font-mono text-sm">{row.value}</dd>
            </div>
          ))}
        </dl>
      </SheetContent>
    </Sheet>
  );
}
