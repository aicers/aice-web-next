"use client";

import type { TriageAsset } from "@/lib/triage";
import { cn } from "@/lib/utils";

export interface TriageAssetListLabels {
  title: string;
  empty: string;
  addressColumn: string;
  scoreColumn: string;
  triagedColumn: string;
  detectedColumn: string;
  rowDetailsTemplate: string;
}

interface TriageAssetListViewProps {
  assets: TriageAsset[];
  selectedAddress: string | null;
  onSelect: (address: string) => void;
  labels: TriageAssetListLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageAssetListView({
  assets,
  selectedAddress,
  onSelect,
  labels,
}: TriageAssetListViewProps) {
  if (assets.length === 0) {
    return (
      <section
        aria-labelledby="triage-asset-list-heading"
        className="rounded-md border bg-card p-4 shadow-xs"
      >
        <h2
          id="triage-asset-list-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          {labels.title}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">{labels.empty}</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="triage-asset-list-heading"
      className="rounded-md border bg-card shadow-xs"
    >
      <header className="border-b px-4 py-3">
        <h2
          id="triage-asset-list-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          {labels.title}
        </h2>
      </header>
      <ul className="divide-y" aria-label={labels.title}>
        {assets.map((asset) => {
          const active = asset.address === selectedAddress;
          const accessibleLabel = labels.rowDetailsTemplate
            .replace("{address}", asset.address)
            .replace("{score}", SCORE_FORMAT.format(asset.score))
            .replace("{triaged}", COUNT_FORMAT.format(asset.triagedCount))
            .replace("{detected}", COUNT_FORMAT.format(asset.detectedCount));
          return (
            <li key={asset.address}>
              <button
                type="button"
                onClick={() => onSelect(asset.address)}
                aria-pressed={active}
                aria-label={accessibleLabel}
                className={cn(
                  "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/40",
                )}
              >
                <span className="font-mono text-sm">{asset.address}</span>
                <span className="flex shrink-0 items-baseline gap-3 text-xs text-muted-foreground">
                  <span>
                    <span className="text-base font-semibold text-foreground">
                      {SCORE_FORMAT.format(asset.score)}
                    </span>{" "}
                    {labels.scoreColumn}
                  </span>
                  <span>
                    {COUNT_FORMAT.format(asset.triagedCount)}{" "}
                    {labels.triagedColumn}
                  </span>
                  <span>
                    {COUNT_FORMAT.format(asset.detectedCount)}{" "}
                    {labels.detectedColumn}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
