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
  formatFieldValue,
  type RecordDef,
  type SysmonRawEventEdge,
} from "@/lib/event";

/**
 * Generic results table for any Sysmon record type. The columns and per
 * cell formatting are driven entirely by `def.tableFields`, so all 14
 * endpoint types share this one component — adding a type is a record
 * definition edit, not a new table. Raises `onRowOpen` with the full
 * record so the parent can show the detail sheet; row keys use the Relay
 * cursor.
 */
export function SysmonResultsTable({
  def,
  edges,
  onRowOpen,
}: {
  def: RecordDef;
  edges: SysmonRawEventEdge[];
  onRowOpen: (edge: SysmonRawEventEdge) => void;
}) {
  const t = useTranslations("event");
  const tf = useTranslations("event.fields");
  const booleanLabels = { true: t("boolean.true"), false: t("boolean.false") };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {def.tableFields.map((field) => (
            <TableHead key={field.name}>{tf(field.name)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((edge) => (
          <TableRow
            key={edge.cursor}
            className="cursor-pointer"
            onClick={() => onRowOpen(edge)}
            tabIndex={0}
            aria-label={t("table.viewDetail")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onRowOpen(edge);
              }
            }}
          >
            {def.tableFields.map((field) => (
              <TableCell
                key={field.name}
                className="max-w-xs truncate font-mono text-xs"
              >
                {formatFieldValue(
                  edge.node[field.name],
                  field.kind,
                  booleanLabels,
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
