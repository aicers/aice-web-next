"use client";

import { useTranslations } from "next-intl";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AnyFieldDescriptor,
  EMPTY_VALUE,
  formatEndpoint,
  protoLabel,
  type RawEvent,
  type RawEventEdge,
  type RawEventFieldValue,
  type RecordDescriptor,
  recordFamily,
  STRING_NUMBER_KINDS,
  summaryText,
} from "@/lib/event";

/** Read an arbitrary descriptor field off a record node. */
function fieldValue(
  record: RawEvent,
  key: string,
): RawEventFieldValue | undefined {
  return (record as unknown as Record<string, RawEventFieldValue>)[key];
}

/** Count columns are right-aligned for scan-ability. */
function isNumericColumn(field: AnyFieldDescriptor): boolean {
  return (
    field.format !== "proto" &&
    (field.scalar === "int" || STRING_NUMBER_KINDS.has(field.scalar))
  );
}

/**
 * Descriptor-driven results table shared by every record type. The
 * leading columns are family-specific: the **network** family leads with
 * time, source, destination, and protocol (source/destination render as
 * `address:port` endpoints, or a bare address for Icmp); the **sysmon**
 * family leads with time, agent, image, and user instead — it carries no
 * IP/port/proto. The trailing columns come from the descriptor's curated
 * `summaryKeys`. Wide and list/sub-record fields collapse to a compact
 * cell here — the full value lives in the row detail. Row keys use the
 * Relay cursor, which is stable per record.
 */
export function RawEventResultsTable({
  descriptor,
  edges,
  locale,
  onRowOpen,
}: {
  descriptor: RecordDescriptor;
  edges: RawEventEdge<RawEvent>[];
  locale: string;
  onRowOpen: (edge: RawEventEdge<RawEvent>) => void;
}) {
  const t = useTranslations("event.table");
  const tf = useTranslations("event.fields");

  const isSysmon = recordFamily(descriptor.id) === "sysmon";
  const byKey = new Map(descriptor.fields.map((f) => [f.key, f]));
  const protoField = byKey.get("proto");
  const summaryFields = descriptor.summaryKeys
    .map((key) => byKey.get(key))
    .filter((f): f is AnyFieldDescriptor => f !== undefined);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("time")}</TableHead>
          {isSysmon ? (
            <>
              <TableHead>{tf("agentName")}</TableHead>
              <TableHead>{tf("image")}</TableHead>
              <TableHead>{tf("user")}</TableHead>
            </>
          ) : (
            <>
              <TableHead>{t("source")}</TableHead>
              <TableHead>{t("destination")}</TableHead>
              {protoField ? <TableHead>{tf("proto")}</TableHead> : null}
            </>
          )}
          {summaryFields.map((f) => (
            <TableHead
              key={f.key}
              className={isNumericColumn(f) ? "text-right" : undefined}
            >
              {tf(f.key)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((edge) => {
          const e = edge.node;
          const origAddr = String(fieldValue(e, "origAddr") ?? "");
          const respAddr = String(fieldValue(e, "respAddr") ?? "");
          const source = descriptor.hasPorts
            ? formatEndpoint(origAddr, Number(fieldValue(e, "origPort")))
            : origAddr;
          const destination = descriptor.hasPorts
            ? formatEndpoint(respAddr, Number(fieldValue(e, "respPort")))
            : respAddr;
          return (
            <TableRow
              key={edge.cursor}
              className="cursor-pointer"
              onClick={() => onRowOpen(edge)}
              tabIndex={0}
              aria-label={t("viewDetail")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowOpen(edge);
                }
              }}
            >
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {String(fieldValue(e, "time") ?? EMPTY_VALUE)}
              </TableCell>
              {isSysmon ? (
                <>
                  <TableCell className="max-w-[20rem] truncate font-mono text-xs">
                    {String(fieldValue(e, "agentName") ?? EMPTY_VALUE)}
                  </TableCell>
                  <TableCell className="max-w-[20rem] truncate font-mono text-xs">
                    {String(fieldValue(e, "image") ?? EMPTY_VALUE)}
                  </TableCell>
                  <TableCell className="max-w-[20rem] truncate font-mono text-xs">
                    {String(fieldValue(e, "user") ?? EMPTY_VALUE)}
                  </TableCell>
                </>
              ) : (
                <>
                  <TableCell className="font-mono text-xs">{source}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {destination}
                  </TableCell>
                  {protoField ? (
                    <TableCell>
                      {protoLabel(Number(fieldValue(e, "proto")))}
                    </TableCell>
                  ) : null}
                </>
              )}
              {summaryFields.map((f) => (
                <TableCell
                  key={f.key}
                  className={
                    isNumericColumn(f)
                      ? "text-right font-mono text-xs"
                      : "max-w-[20rem] truncate font-mono text-xs"
                  }
                >
                  {summaryText(
                    fieldValue(e, f.key),
                    f.scalar,
                    f.format,
                    locale,
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
