"use client";

import { cn } from "@/lib/utils";

/**
 * Tier 1 / Tier 2 scope toggle (#453).
 *
 * Two states:
 *
 *   - **Triaged only** (default — Tier 1, reads only the loaded
 *     corpus; no fresh round-trips when the operator clicks a
 *     dimension).
 *   - **All detection events** (Tier 2 — server-filtered dimensions
 *     trigger fresh `eventList` round-trips on click).
 *
 * Default state is Tier 1 for every fresh menu entry; the toggle is
 * not persisted across sessions (URL-hash persistence covers the
 * share/reload case). Toggling to Tier 2 does NOT issue any
 * round-trips on its own — round-trips fire only when the operator
 * clicks a server-filtered dimension.
 */
export type TriagePivotScope = "tier1" | "tier2";

export interface TriagePivotScopeToggleLabels {
  legend: string;
  tier1: string;
  tier2: string;
  tier1Hint: string;
  tier2Hint: string;
}

interface TriagePivotScopeToggleProps {
  scope: TriagePivotScope;
  onChange: (next: TriagePivotScope) => void;
  labels: TriagePivotScopeToggleLabels;
}

export function TriagePivotScopeToggle({
  scope,
  onChange,
  labels,
}: TriagePivotScopeToggleProps) {
  return (
    <fieldset className="flex items-center gap-2" aria-label={labels.legend}>
      <legend className="sr-only">{labels.legend}</legend>
      <div
        role="tablist"
        aria-label={labels.legend}
        className="inline-flex rounded-md border bg-card p-0.5 shadow-xs"
      >
        <ScopeButton
          active={scope === "tier1"}
          onClick={() => onChange("tier1")}
          label={labels.tier1}
          title={labels.tier1Hint}
        />
        <ScopeButton
          active={scope === "tier2"}
          onClick={() => onChange("tier2")}
          label={labels.tier2}
          title={labels.tier2Hint}
        />
      </div>
    </fieldset>
  );
}

interface ScopeButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}

function ScopeButton({ active, onClick, label, title }: ScopeButtonProps) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
