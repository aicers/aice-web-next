"use client";

import { cn } from "@/lib/utils";

/**
 * Triage mode toggle. Phase 1.A only wires the "Baseline" branch;
 * "With my policies" is the deprecatable seam (§6 of discussion #447)
 * — when policies arrive, the unwired branch becomes a real route /
 * subtree imported here, and the toggle remains the single import
 * point. Removing the toggle (and the second branch) reduces the
 * page to baseline-only with a one-line edit.
 */
export type TriageMode = "baseline" | "policies";

export interface TriageModeToggleLabels {
  legend: string;
  baseline: string;
  policies: string;
  policiesUnavailable: string;
}

interface TriageModeToggleProps {
  mode: TriageMode;
  onChange: (next: TriageMode) => void;
  labels: TriageModeToggleLabels;
}

export function TriageModeToggle({
  mode,
  onChange,
  labels,
}: TriageModeToggleProps) {
  return (
    <fieldset className="flex items-center gap-2" aria-label={labels.legend}>
      <legend className="sr-only">{labels.legend}</legend>
      <div
        role="tablist"
        aria-label={labels.legend}
        className="inline-flex rounded-md border bg-card p-0.5 shadow-xs"
      >
        <ModeButton
          active={mode === "baseline"}
          onClick={() => onChange("baseline")}
          label={labels.baseline}
        />
        <ModeButton
          active={mode === "policies"}
          onClick={() => onChange("policies")}
          label={labels.policies}
          disabled
          title={labels.policiesUnavailable}
        />
      </div>
    </fieldset>
  );
}

interface ModeButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}

function ModeButton({
  active,
  onClick,
  label,
  disabled,
  title,
}: ModeButtonProps) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}
