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

/**
 * PCAP tab — parsed packet view (primary) + a "Download .pcap" action.
 *
 * Per the v1 scope decision there is no in-app raw-packets browser:
 * raw bytes have no standalone value in-app, so the only raw-byte path
 * is the binary download (the `<a download>` to the Route Handler).
 * The parsed text is fetched lazily on first activation via the
 * `loadEventPcap` server action (Radix unmounts inactive
 * `TabsContent`), mirroring the Endpoints / Related tabs, so Giganto
 * is not contacted for users who never open the tab.
 */
export function PcapTab({ sensor, requestTime, labels }: Props) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

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
         * Plain anchor (not next-intl Link) — `/api/...` is not a
         * localized route, and `download` lets the browser save the
         * binary response the Route Handler streams with
         * Content-Disposition. The raw `packet` bytes are assembled
         * server-side; nothing binary crosses React state here.
         */}
        <Button asChild size="sm" variant="outline">
          <a href={downloadHref} download={labels.downloadName} rel="nofollow">
            <Download className="size-4" aria-hidden="true" />
            {labels.download}
          </a>
        </Button>
      </header>
      <PcapBody state={state} labels={labels} />
    </section>
  );
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
