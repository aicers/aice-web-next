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
  type AnyFieldDescriptor,
  EMPTY_VALUE,
  formatEndpoint,
  listText,
  type RawEvent,
  type RawEventFieldValue,
  type RecordDescriptor,
  recordFamily,
  SUB_RECORD_FIELDS,
  scalarText,
} from "@/lib/event";

type SubRecordKey = keyof typeof SUB_RECORD_FIELDS;

function fieldValue(
  record: Record<string, RawEventFieldValue>,
  key: string,
): RawEventFieldValue | undefined {
  return record[key];
}

/** Resolve the sub-record descriptor for a `sub:*` scalar. */
function subKeyOf(scalar: string): SubRecordKey | null {
  const key = scalar.startsWith("sub:") ? scalar.slice(4) : "";
  return key in SUB_RECORD_FIELDS ? (key as SubRecordKey) : null;
}

/**
 * Row-detail view for any network raw event. Renders every descriptor
 * field as a definition-list entry: scalars as text, lists joined,
 * byte-array matrices one row per line, and nested sub-records
 * (DCE/RPC contexts, FTP commands, DHCP options) as labelled sub-blocks.
 * Controlled: a non-null `record` opens the sheet.
 */
export function RawEventDetailSheet({
  descriptor,
  record,
  locale,
  onClose,
}: {
  descriptor: RecordDescriptor;
  record: RawEvent | null;
  locale: string;
  onClose: () => void;
}) {
  const t = useTranslations("event");
  const tf = useTranslations("event.fields");

  const node = record as unknown as Record<string, RawEventFieldValue> | null;

  return (
    <Sheet
      open={record !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t(`recordTypes.${descriptor.id}`)}</SheetTitle>
          {node ? (
            <SheetDescription>
              {endpointSummary(node, descriptor)}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        {node ? (
          <dl className="grid grid-cols-1 gap-px px-4 pb-6">
            {descriptor.fields.map((field) => (
              <div
                key={field.key}
                className="bg-card flex flex-col gap-0.5 py-2"
              >
                <dt className="text-muted-foreground text-xs font-medium">
                  {tf(field.key)}
                </dt>
                <dd className="break-all font-mono text-sm">
                  <FieldBody
                    value={fieldValue(node, field.key)}
                    field={field}
                    locale={locale}
                  />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function endpointSummary(
  node: Record<string, RawEventFieldValue>,
  descriptor: RecordDescriptor,
): string {
  // Sysmon records have no network endpoints; identify them by agent and
  // image instead.
  if (recordFamily(descriptor.id) === "sysmon") {
    const agentName = String(node.agentName ?? "");
    const image = String(node.image ?? "");
    return image ? `${agentName} · ${image}` : agentName;
  }
  const origAddr = String(node.origAddr ?? "");
  const respAddr = String(node.respAddr ?? "");
  if (!descriptor.hasPorts) return `${origAddr} → ${respAddr}`;
  const source = formatEndpoint(origAddr, Number(node.origPort));
  const destination = formatEndpoint(respAddr, Number(node.respPort));
  return `${source} → ${destination}`;
}

/** Render a single field value per its descriptor scalar kind. */
function FieldBody({
  value,
  field,
  locale,
}: {
  value: RawEventFieldValue | undefined;
  field: AnyFieldDescriptor;
  locale: string;
}) {
  if (value === undefined || value === null) {
    return <>{EMPTY_VALUE}</>;
  }

  switch (field.scalar) {
    case "stringList":
    case "intList":
      return (
        <>
          {listText(
            Array.isArray(value) ? (value as Array<string | number>) : [],
          )}
        </>
      );
    case "intMatrix":
      return <ByteMatrix rows={value as number[][]} />;
    case "sub:dceRpcContext":
    case "sub:ftpCommand":
    case "sub:dhcpOption":
      return (
        <SubRecords
          scalar={field.scalar}
          rows={value as unknown as Array<Record<string, RawEventFieldValue>>}
          locale={locale}
        />
      );
    default:
      return <>{scalarText(value, field.scalar, field.format, locale)}</>;
  }
}

/** Byte-array matrix (`[[Int!]!]!`) — one comma-joined row per line. */
function ByteMatrix({ rows }: { rows: number[][] }) {
  if (rows.length === 0) return <>{EMPTY_VALUE}</>;
  return (
    <ul className="space-y-0.5">
      {rows.map((row, index) => (
        // Row order is meaningful and stable for a given record, so the
        // index is an acceptable key here.
        // biome-ignore lint/suspicious/noArrayIndexKey: payload rows are positional
        <li key={index} className="break-all">
          [{row.join(", ")}]
        </li>
      ))}
    </ul>
  );
}

/** Nested sub-records, each rendered as a labelled mini definition list. */
function SubRecords({
  scalar,
  rows,
  locale,
}: {
  scalar: string;
  rows: Array<Record<string, RawEventFieldValue>>;
  locale: string;
}) {
  const tf = useTranslations("event.fields");
  const subKey = subKeyOf(scalar);
  if (!subKey || rows.length === 0) return <>{EMPTY_VALUE}</>;
  const subFields = SUB_RECORD_FIELDS[subKey];

  return (
    <ul className="space-y-2">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sub-records are positional
        <li key={index} className="rounded border px-2 py-1.5">
          <dl className="grid grid-cols-1 gap-px">
            {subFields.map((field) => (
              <div
                key={field.key}
                className="flex justify-between gap-3 py-0.5"
              >
                <dt className="text-muted-foreground text-xs">
                  {tf(field.key)}
                </dt>
                <dd className="text-right text-xs break-all">
                  <SubFieldBody
                    value={row[field.key]}
                    field={field}
                    locale={locale}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** Sub-record fields are scalars or int lists — no further nesting. */
function SubFieldBody({
  value,
  field,
  locale,
}: {
  value: RawEventFieldValue | undefined;
  field: AnyFieldDescriptor;
  locale: string;
}) {
  if (value === undefined || value === null) return <>{EMPTY_VALUE}</>;
  if (field.scalar === "intList" || field.scalar === "stringList") {
    return (
      <>
        {listText(
          Array.isArray(value) ? (value as Array<string | number>) : [],
        )}
      </>
    );
  }
  return <>{scalarText(value, field.scalar, field.format, locale)}</>;
}
