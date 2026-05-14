"use client";

/**
 * Triage menu tab strip (#490).
 *
 * Three peer views inside Baseline mode — Asset list (default),
 * Stories, Pivot. "With my policies" mode receives a two-tab variant
 * (no Stories) by passing `mode === "policies"`; the Stories tab is
 * NOT rendered as disabled or empty — it simply does not appear in
 * the tab list. The decision is centralized in this component so any
 * future tab gating (per-permission, per-feature-flag) lives in one
 * place rather than spreading across renderers.
 */

import type { TriageMode } from "./mode-toggle";

export type TriageTabId = "asset-list" | "stories" | "pivot";

export interface TriageTabStripLabels {
  legend: string;
  assetList: string;
  stories: string;
  pivot: string;
}

interface TriageTabStripProps {
  tab: TriageTabId;
  mode: TriageMode;
  onChange: (next: TriageTabId) => void;
  labels: TriageTabStripLabels;
}

export function tabsForMode(mode: TriageMode): readonly TriageTabId[] {
  // Story v1 is corpus-A-only (#489); the Stories tab is intentionally
  // hidden when the analyst is on the policy corpus path. See the
  // "Stories is intentionally hidden in 'With my policies' mode"
  // section of #490 for the rationale.
  if (mode === "policies") return ["asset-list", "pivot"];
  return ["asset-list", "stories", "pivot"];
}

function labelFor(tab: TriageTabId, labels: TriageTabStripLabels): string {
  switch (tab) {
    case "asset-list":
      return labels.assetList;
    case "stories":
      return labels.stories;
    case "pivot":
      return labels.pivot;
  }
}

export function TriageTabStrip({
  tab,
  mode,
  onChange,
  labels,
}: TriageTabStripProps) {
  const tabs = tabsForMode(mode);
  return (
    <div
      role="tablist"
      aria-label={labels.legend}
      className="flex items-center gap-1 border-b border-border"
    >
      {tabs.map((id) => {
        const active = id === tab;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`triage-tab-${id}`}
            data-state={active ? "active" : "inactive"}
            onClick={() => onChange(id)}
            className={[
              "border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {labelFor(id, labels)}
          </button>
        );
      })}
    </div>
  );
}
