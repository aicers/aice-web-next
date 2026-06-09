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
  type ConnRawEventEdge,
  formatCount,
  formatEndpoint,
  protoLabel,
} from "@/lib/event";

/**
 * Conn vertical-slice results table. Renders the compact column set
 * (time, endpoints, protocol, state, service, byte counts) and raises
 * `onRowOpen` with the full record so the parent can show the detail
 * sheet. Row keys use the Relay cursor, which is stable per record.
 */
export function ConnResultsTable({
  edges,
  locale,
  onRowOpen,
}: {
  edges: ConnRawEventEdge[];
  locale: string;
  onRowOpen: (edge: ConnRawEventEdge) => void;
}) {
  const t = useTranslations("event.table");

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("time")}</TableHead>
          <TableHead>{t("source")}</TableHead>
          <TableHead>{t("destination")}</TableHead>
          <TableHead>{t("proto")}</TableHead>
          <TableHead>{t("connState")}</TableHead>
          <TableHead>{t("service")}</TableHead>
          <TableHead className="text-right">{t("origBytes")}</TableHead>
          <TableHead className="text-right">{t("respBytes")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((edge) => {
          const e = edge.node;
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
                {e.time}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {formatEndpoint(e.origAddr, e.origPort)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {formatEndpoint(e.respAddr, e.respPort)}
              </TableCell>
              <TableCell>{protoLabel(e.proto)}</TableCell>
              <TableCell className="font-mono text-xs">
                {e.connState || "—"}
              </TableCell>
              <TableCell>{e.service || "—"}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatCount(e.origBytes, locale)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatCount(e.respBytes, locale)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
