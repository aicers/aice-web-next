"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { loadEventPcap, type PcapViewResult } from "@/lib/detection/pcap-view";

export interface PcapLabels {
  title: string;
  description: string;
  loading: string;
  empty: string;
  forbidden: string;
  unavailable: string;
  error: string;
  download: string;
  downloading: string;
  downloadError: string;
  downloadName: string;
}

interface Props {
  /** Sensor id the event was detected on; Giganto's `PacketFilter.sensor`. */
  sensor: string;
  /** Event time (RFC 3339), mapped to `PacketFilter.requestTime`. */
  requestTime: string;
  labels: PcapLabels;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; result: PcapViewResult };

type DownloadState =
  | { phase: "idle" }
  | { phase: "downloading" }
  | { phase: "empty" }
  | { phase: "error" };

/**
 * PCAP tab — parsed packet view (primary) + a "Download .pcap" action.
 *
 * Per the v1 scope decision there is no in-app raw-packets browser:
 * raw bytes have no standalone value in-app, so the only raw-byte path
 * is the binary download to the Route Handler. The download is driven
 * by `fetch` (not a plain `<a download>`): the route answers an empty
 * capture with `404 { code: "no-packet-data" }`, which a navigation
 * anchor would silently swallow, so JS reads the status and shows the
 * empty / error message in-app instead. On success it saves the
 * response blob, applying the server's `Content-Disposition` filename
 * (a fetch-driven save no longer auto-applies it the way a navigation
 * did). The parsed text is fetched lazily on first activation via the
 * `loadEventPcap` server action (Radix unmounts inactive
 * `TabsContent`), mirroring the Endpoints / Related tabs, so Giganto
 * is not contacted for users who never open the tab.
 */
export function PcapTab({ sensor, requestTime, labels }: Props) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [download, setDownload] = useState<DownloadState>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    loadEventPcap(sensor, requestTime)
      .then((result) => {
        if (!cancelled) setState({ phase: "loaded", result });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ phase: "loaded", result: { status: "error" } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sensor, requestTime]);

  const downloadHref = `/api/detection/pcap?sensor=${encodeURIComponent(
    sensor,
  )}&requestTime=${encodeURIComponent(requestTime)}`;

  async function handleDownload() {
    setDownload({ phase: "downloading" });
    try {
      const res = await fetch(downloadHref);
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        // Distinguish "no capture stored" (show the empty state) from
        // any other 404 (treat as a download failure).
        setDownload(
          body?.code === "no-packet-data"
            ? { phase: "empty" }
            : { phase: "error" },
        );
        return;
      }
      if (!res.ok) {
        setDownload({ phase: "error" });
        return;
      }
      const blob = await res.blob();
      const filename =
        filenameFromDisposition(res.headers.get("Content-Disposition")) ??
        labels.downloadName;
      saveBlob(blob, filename);
      setDownload({ phase: "idle" });
    } catch {
      setDownload({ phase: "error" });
    }
  }

  const busy = download.phase === "downloading";

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-sm font-semibold">
            {labels.title}
          </h2>
          <p className="text-muted-foreground text-sm">{labels.description}</p>
        </div>
        {/*
         * Fetch-driven (not a plain `<a download>`): the route's 404
         * empty-state body cannot be surfaced through a navigation
         * anchor, and the saved file needs the server's
         * Content-Disposition filename applied client-side. The raw
         * `packet` bytes are assembled server-side and only ever touch
         * the response blob — never React state.
         */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownload}
          disabled={busy}
          aria-busy={busy}
        >
          <Download className="size-4" aria-hidden="true" />
          {busy ? labels.downloading : labels.download}
        </Button>
      </header>
      {download.phase === "empty" && <Message text={labels.empty} />}
      {download.phase === "error" && <Message text={labels.downloadError} />}
      <PcapBody state={state} labels={labels} />
    </section>
  );
}

/**
 * Parse the filename from a `Content-Disposition` header. Reads the
 * RFC 5987 `filename*=` form first, then the plain `filename=`. Returns
 * `null` when absent / unparseable so the caller falls back to the
 * static client-side name.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const raw = extended?.[1] ?? plain?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Trigger a browser save of a blob via a transient object-URL anchor. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "nofollow";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PcapBody({ state, labels }: { state: LoadState; labels: PcapLabels }) {
  if (state.phase === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-xs"
      >
        {labels.loading}
      </p>
    );
  }
  const result = state.result;
  if (result.status === "forbidden") {
    return <Message text={labels.forbidden} />;
  }
  if (result.status === "unavailable") {
    return <Message text={labels.unavailable} />;
  }
  if (result.status === "error") {
    return <Message text={labels.error} />;
  }
  if (result.parsedPcap.trim().length === 0) {
    return <Message text={labels.empty} />;
  }
  return (
    <pre className="bg-muted/50 text-foreground max-h-[32rem] overflow-auto rounded-md p-3 text-xs leading-5">
      <code>{result.parsedPcap}</code>
    </pre>
  );
}

function Message({ text }: { text: string }) {
  return <p className="text-muted-foreground text-sm">{text}</p>;
}
