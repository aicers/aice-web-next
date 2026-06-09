"use client";

import { useTranslations } from "next-intl";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  formatFieldValue,
  type RecordDef,
  type SysmonRawEventNode,
} from "@/lib/event";

/**
 * Generic row-detail view for any Sysmon record type. Renders every
 * field in `def.detailFields` as a definition list, formatted by field
 * kind — the same data-driven approach as {@link SysmonResultsTable}, so
 * all 14 endpoint types share this one sheet. Controlled: `event`
 * non-null opens the sheet; closing it raises `onClose`.
 */
export function SysmonDetailSheet({
  def,
  event,
  onClose,
}: {
  def: RecordDef;
  event: SysmonRawEventNode | null;
  onClose: () => void;
}) {
  const t = useTranslations("event");
  const tf = useTranslations("event.fields");
  const booleanLabels = { true: t("boolean.true"), false: t("boolean.false") };

  const rows = event
    ? def.detailFields.map((field) => ({
        label: tf(field.name),
        value: formatFieldValue(event[field.name], field.kind, booleanLabels),
      }))
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
          <SheetTitle>{t(`recordTypes.${def.id}`)}</SheetTitle>
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
