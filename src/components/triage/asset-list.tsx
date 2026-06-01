"use client";

import { panelSurface } from "@/components/ui/panel-surface";
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
  /**
   * Suffix on the per-row "detected" cell when the observed
   * denominator for this asset's window contribution is retention-
   * truncated. The label fires per-row on the subset whose in-
   * retention slice produced no observed events; the result-level
   * label on the funnel covers the broader truncation case.
   */
  detectedOver30dHint: string;
}

export interface TriageAssetSelection {
  customerId: number;
  address: string;
}

interface TriageAssetListViewProps {
  assets: TriageAsset[];
  selected: TriageAssetSelection | null;
  /**
   * `true` when the request-level window starts before
   * `now() − observed_event_meta_retention`. Drives the per-row
   * truncation badge; mirrors {@link TriageLoadResult.observedDenominatorTruncated}.
   */
  observedDenominatorTruncated: boolean;
  onSelect: (selection: TriageAssetSelection) => void;
  labels: TriageAssetListLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageAssetListView({
  assets,
  selected,
  observedDenominatorTruncated,
  onSelect,
  labels,
}: TriageAssetListViewProps) {
  if (assets.length === 0) {
    return (
      <section
        aria-labelledby="triage-asset-list-heading"
        className={cn(panelSurface, "p-4")}
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
      className={panelSurface}
    >
      <header className="border-b border-border/30 px-4 py-3">
        <h2
          id="triage-asset-list-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          {labels.title}
        </h2>
      </header>
      <ul className="divide-y divide-border/30" aria-label={labels.title}>
        {assets.map((asset) => {
          const active =
            selected !== null &&
            asset.customerId === selected.customerId &&
            asset.address === selected.address;
          const accessibleLabel = labels.rowDetailsTemplate
            .replace("{address}", asset.address)
            .replace("{score}", SCORE_FORMAT.format(asset.score))
            .replace("{triaged}", COUNT_FORMAT.format(asset.triagedCount))
            .replace("{detected}", COUNT_FORMAT.format(asset.detectedCount));
          // Per-row truncation label: fires only when the result-level
          // flag holds AND this row's observed slice is unavailable
          // (the per-asset condition documented in #458). Visually
          // tagged so an operator scanning the list can tell apart
          // "denominator unknown" from "denominator zero".
          const showTruncationHint =
            observedDenominatorTruncated && asset.detectedCountUnavailable;
          return (
            <li key={`${asset.customerId}/${asset.address}`}>
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    customerId: asset.customerId,
                    address: asset.address,
                  })
                }
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
                    {showTruncationHint ? (
                      <>
                        {" "}
                        <span className="text-amber-700 dark:text-amber-300">
                          {labels.detectedOver30dHint}
                        </span>
                      </>
                    ) : null}
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
