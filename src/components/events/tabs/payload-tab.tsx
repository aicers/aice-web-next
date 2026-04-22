"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Event } from "@/lib/detection/types";

export interface PayloadLabels {
  title: string;
  description: string;
  size: string;
  bytes: string;
  download: string;
  downloadName: string;
}

interface Props {
  event: Event;
  labels: PayloadLabels;
}

/**
 * Captured-payload view. The issue's original scope called for a
 * raw packet-capture hex dump, but REview does not expose a raw
 * packet-capture field on any subtype today — only `HttpThreat.body`
 * carries captured bytes. v1 is therefore scoped honestly to the
 * application payload rather than link-layer packets; the tab label
 * is "Payload" (not "Packets") so investigators don't read more into
 * the bytes than REview actually provides. When REview adds a true
 * packet-capture field, extend `extractPayloadBytes` to return it
 * and re-scope the label.
 */
export function PayloadTab({ event, labels }: Props) {
  const bytes = extractPayloadBytes(event);
  if (!bytes) return null;

  const hex = formatHexDump(bytes);
  const byteCountLabel = labels.bytes.replace(
    "{count}",
    bytes.length.toLocaleString(),
  );

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-foreground text-sm font-semibold">
          {labels.title}
        </h2>
        <p className="text-muted-foreground text-sm">{labels.description}</p>
      </header>
      <dl className="text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">{labels.size}</dt>
          <dd className="text-foreground font-mono">{byteCountLabel}</dd>
        </div>
      </dl>
      <DownloadButton
        bytes={bytes}
        label={labels.download}
        filename={labels.downloadName}
      />
      <pre className="bg-muted/50 text-foreground max-h-96 overflow-auto rounded-md p-3 text-xs leading-5">
        <code>{hex}</code>
      </pre>
    </section>
  );
}

export function hasPayloadData(event: Event): boolean {
  const bytes = extractPayloadBytes(event);
  return bytes !== null && bytes.length > 0;
}

function extractPayloadBytes(event: Event): number[] | null {
  const withBody = event as Partial<{ body: number[] }>;
  if (Array.isArray(withBody.body) && withBody.body.length > 0) {
    return withBody.body;
  }
  return null;
}

function formatHexDump(bytes: number[]): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.slice(offset, offset + 16);
    const hex = slice
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(16 * 3 - 1, " ");
    const ascii = slice
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return rows.join("\n");
}

function DownloadButton({
  bytes,
  label,
  filename,
}: {
  bytes: number[];
  label: string;
  filename: string;
}) {
  const onClick = () => {
    const buffer = new Uint8Array(bytes);
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={onClick}>
      <Download className="size-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
