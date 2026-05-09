"use client";

/**
 * Baseline-mode body of the Triage page. Phase 1.A — discussion #447
 * §6 deprecatable seam: this subtree must NOT import any policy
 * module so removing the mode toggle reduces the page to baseline-
 * only with a one-line edit. The funnel/asset-list/asset-detail
 * primitives, the scoring rule, and this file are all the policy-
 * free baseline tree.
 */

import { useMemo, useState } from "react";

import type { TriageLoadResult } from "@/lib/triage";

import {
  type TriageAssetDetailLabels,
  TriageAssetDetailView,
} from "./asset-detail";
import { type TriageAssetListLabels, TriageAssetListView } from "./asset-list";
import { type TriageFunnelLabels, TriageFunnelView } from "./funnel";

export interface TriageBaselineLabels {
  funnel: TriageFunnelLabels;
  assetList: TriageAssetListLabels;
  assetDetail: TriageAssetDetailLabels;
}

interface TriageBaselineContentProps {
  result: TriageLoadResult;
  labels: TriageBaselineLabels;
}

export function TriageBaselineContent({
  result,
  labels,
}: TriageBaselineContentProps) {
  const initialAddress = result.assets[0]?.address ?? null;
  const [selectedAddress, setSelectedAddress] = useState<string | null>(
    initialAddress,
  );

  const selectedAsset = useMemo(() => {
    if (!selectedAddress) return null;
    return result.assets.find((a) => a.address === selectedAddress) ?? null;
  }, [result.assets, selectedAddress]);

  // Reset the selection when the loaded asset list no longer contains
  // the previously-selected row (e.g., after a period change).
  const effectiveSelection =
    selectedAsset === null && initialAddress !== null
      ? initialAddress
      : selectedAddress;
  const effectiveAsset =
    selectedAsset ?? (initialAddress ? (result.assets[0] ?? null) : null);

  return (
    <div className="space-y-6">
      <TriageFunnelView funnel={result.funnel} labels={labels.funnel} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <TriageAssetListView
          assets={result.assets}
          selectedAddress={effectiveSelection}
          onSelect={setSelectedAddress}
          labels={labels.assetList}
        />
        <TriageAssetDetailView
          asset={effectiveAsset}
          labels={labels.assetDetail}
        />
      </div>
    </div>
  );
}
